package api

// Fleet-wide cost overview + 3-month linear forecast.
//
// The existing /costs/_panels/overview.tsx is per-cluster: it picks one
// cluster off the top-right selector and renders that cluster's
// snapshots. This endpoint does the cross-cluster aggregation in one
// query, exposes:
//
//   - monthly fleet totals (cost + counterfactual) for the last N months
//   - per-cluster current-month totals (for ranking who's expensive)
//   - a linear-regression forecast for the next 3 months
//
// Forecasting choice: simple least-squares on monthly totals. No AI
// call in the math path — the forecast is meant to be defensible
// arithmetic, not a black box. The narrative explainer (if AI is
// available) is layered on top as a separate field the operator can
// choose to look at; it never changes the numbers.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/seaweedfs/seaweedfs-tiering-controller/internal/store"
)

const (
	fleetForecastMonths = 3
	fleetMaxHistory     = 24
)

// fleetMonthPoint is one row in the time-series the UI charts.
type fleetMonthPoint struct {
	YearMonth          string  `json:"year_month"` // YYYY-MM
	CostEstimate       float64 `json:"cost_estimate"`
	CounterfactualCost float64 `json:"counterfactual_cost"`
	PhysicalBytes      int64   `json:"physical_bytes"`
	Forecast           bool    `json:"forecast,omitempty"` // true when this point came from extrapolation
}

// fleetClusterRow is the current-month rollup per cluster, used to
// rank "who is most expensive right now".
type fleetClusterRow struct {
	ClusterID     uuid.UUID `json:"cluster_id"`
	Name          string    `json:"name"`
	CostEstimate  float64   `json:"cost_estimate"`
	PhysicalBytes int64     `json:"physical_bytes"`
	MoMDelta      float64   `json:"mom_delta"`    // month-over-month % change
	HasMoMBase    bool      `json:"has_mom_base"` // false if no prior month data
}

// fleetCostResp is the full payload.
type fleetCostResp struct {
	Months        int               `json:"months"`
	Currency      string            `json:"currency"`
	Series        []fleetMonthPoint `json:"series"`
	Clusters      []fleetClusterRow `json:"clusters"`
	ForecastTrend string            `json:"forecast_trend"` // "rising" | "falling" | "flat" | "insufficient_data"
	Slope         float64           `json:"slope"`          // currency per month
	AIExplainer   string            `json:"ai_explainer,omitempty"`
	AIProvider    string            `json:"ai_provider,omitempty"`
}

// fleetCostOverview handles GET /api/v1/costs/fleet?months=12&explain=true
//
// When explain=true and an AI provider is configured, a short
// narrative is appended. When explain is omitted or the provider is
// missing, the numeric fields still come back — the explainer is a
// nice-to-have, not on the critical path.
func fleetCostOverview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		months := 12
		if s := c.Query("months"); s != "" {
			fmt.Sscanf(s, "%d", &months)
		}
		if months <= 0 || months > fleetMaxHistory {
			months = 12
		}
		explain := strings.EqualFold(c.Query("explain"), "true")

		ctx := c.Request.Context()
		snaps, err := d.PG.ListAllCostSnapshots(ctx, months)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		clusters, err := d.PG.ListClusters(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		nameByID := map[uuid.UUID]string{}
		for _, cl := range clusters {
			nameByID[cl.ID] = cl.Name
		}

		resp := buildFleetCostResp(snaps, nameByID, months)

		if explain && len(resp.Series) >= 2 {
			if narrative, prov, ok := fleetCostExplainer(ctx, d, &resp); ok {
				resp.AIExplainer = narrative
				resp.AIProvider = prov
			}
		}

		c.JSON(http.StatusOK, resp)
	}
}

// buildFleetCostResp does all the math — pure function so it's easy
// to think about and test.
func buildFleetCostResp(snaps []store.CostSnapshot, nameByID map[uuid.UUID]string, months int) fleetCostResp {
	resp := fleetCostResp{Months: months, Currency: "USD"}
	if len(snaps) == 0 {
		resp.ForecastTrend = "insufficient_data"
		return resp
	}
	if c := snaps[0].Currency; c != "" {
		resp.Currency = c
	}

	// Aggregate by year-month for the fleet series.
	type ym struct {
		Year  int
		Month time.Month
	}
	byMonth := map[ym]*fleetMonthPoint{}
	for _, s := range snaps {
		k := ym{s.YearMonth.Year(), s.YearMonth.Month()}
		p, ok := byMonth[k]
		if !ok {
			p = &fleetMonthPoint{
				YearMonth: fmt.Sprintf("%04d-%02d", k.Year, k.Month),
			}
			byMonth[k] = p
		}
		p.CostEstimate += s.CostEstimate
		p.CounterfactualCost += s.CounterfactualCost
		p.PhysicalBytes += s.PhysicalBytes
	}
	series := make([]fleetMonthPoint, 0, len(byMonth))
	for _, p := range byMonth {
		series = append(series, *p)
	}
	sort.Slice(series, func(i, j int) bool { return series[i].YearMonth < series[j].YearMonth })

	// Per-cluster current-month + MoM delta. "Current month" = the
	// newest year_month any cluster has data for. Falls back per
	// cluster when one has no current-month row (e.g. just onboarded).
	clusterMonths := map[uuid.UUID]map[string]float64{}
	clusterBytes := map[uuid.UUID]map[string]int64{}
	for _, s := range snaps {
		yymm := fmt.Sprintf("%04d-%02d", s.YearMonth.Year(), s.YearMonth.Month())
		if clusterMonths[s.ClusterID] == nil {
			clusterMonths[s.ClusterID] = map[string]float64{}
			clusterBytes[s.ClusterID] = map[string]int64{}
		}
		clusterMonths[s.ClusterID][yymm] += s.CostEstimate
		clusterBytes[s.ClusterID][yymm] += s.PhysicalBytes
	}
	currentMonth := series[len(series)-1].YearMonth
	priorMonth := ""
	if len(series) >= 2 {
		priorMonth = series[len(series)-2].YearMonth
	}
	rows := make([]fleetClusterRow, 0, len(clusterMonths))
	for cid, months := range clusterMonths {
		cur := months[currentMonth]
		row := fleetClusterRow{
			ClusterID:     cid,
			Name:          firstNonEmpty(nameByID[cid], cid.String()),
			CostEstimate:  cur,
			PhysicalBytes: clusterBytes[cid][currentMonth],
		}
		if priorMonth != "" {
			if prev, ok := months[priorMonth]; ok && prev > 0 {
				row.MoMDelta = (cur - prev) / prev * 100
				row.HasMoMBase = true
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CostEstimate > rows[j].CostEstimate })
	resp.Clusters = rows

	// Forecast — linear regression on (month_index, cost). Need ≥3
	// observations to publish a slope; fewer just returns the
	// observed series with no extrapolation.
	if len(series) >= 3 {
		slope, intercept := linearFit(series)
		resp.Slope = slope
		switch {
		case math.Abs(slope) < 0.005*avgY(series):
			resp.ForecastTrend = "flat"
		case slope > 0:
			resp.ForecastTrend = "rising"
		default:
			resp.ForecastTrend = "falling"
		}
		// Project fleetForecastMonths months ahead.
		last := lastMonth(series)
		for i := 1; i <= fleetForecastMonths; i++ {
			projected := slope*float64(len(series)+i-1) + intercept
			if projected < 0 {
				projected = 0
			}
			next := last.AddDate(0, i, 0)
			series = append(series, fleetMonthPoint{
				YearMonth:    fmt.Sprintf("%04d-%02d", next.Year(), next.Month()),
				CostEstimate: projected,
				Forecast:     true,
			})
		}
	} else {
		resp.ForecastTrend = "insufficient_data"
	}
	resp.Series = series
	return resp
}

// linearFit returns least-squares (slope, intercept) for cost vs
// month-index. Uses only the OBSERVED part of the series — caller
// must pass it before appending forecast points.
func linearFit(series []fleetMonthPoint) (slope, intercept float64) {
	n := 0
	var sumX, sumY, sumXY, sumX2 float64
	for i, p := range series {
		if p.Forecast {
			continue
		}
		x := float64(i)
		y := p.CostEstimate
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
		n++
	}
	if n < 2 {
		return 0, 0
	}
	denom := float64(n)*sumX2 - sumX*sumX
	if denom == 0 {
		return 0, sumY / float64(n)
	}
	slope = (float64(n)*sumXY - sumX*sumY) / denom
	intercept = (sumY - slope*sumX) / float64(n)
	return
}

func avgY(series []fleetMonthPoint) float64 {
	if len(series) == 0 {
		return 0
	}
	var s float64
	var n int
	for _, p := range series {
		if p.Forecast {
			continue
		}
		s += p.CostEstimate
		n++
	}
	if n == 0 {
		return 0
	}
	return s / float64(n)
}

func lastMonth(series []fleetMonthPoint) time.Time {
	if len(series) == 0 {
		return time.Now()
	}
	last := series[len(series)-1].YearMonth
	t, err := time.Parse("2006-01", last)
	if err != nil {
		return time.Now()
	}
	return t
}

// fleetCostExplainer asks the configured AI provider for a 2-3 sentence
// narrative explaining the trend. The numeric forecast is independent
// of this call — failure here just omits the prose.
func fleetCostExplainer(ctx context.Context, d Deps, r *fleetCostResp) (string, string, bool) {
	provider, perr := resolveAssistantProvider(ctx, d)
	if perr != nil {
		return "", "", false
	}
	chatter, ok := provider.(jsonChatter)
	if !ok {
		return "", "", false
	}
	type out struct {
		Narrative string `json:"narrative"`
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var b strings.Builder
	fmt.Fprintf(&b, `You are a cost-trend interpreter for a SeaweedFS fleet.
Return STRICT JSON: {"narrative":"2-3 sentences explaining the trend and what's driving it."}.

RULES:
- Be specific. Cite cluster names + numbers from the data below.
- Don't invent — only use what's in the inputs.
- Don't recommend specific actions; just describe.

CURRENCY: %s
TREND: %s   (slope = %.2f %s / month over %d observed months)

MONTHLY FLEET SERIES (observed only):
`, r.Currency, r.ForecastTrend, r.Slope, r.Currency, r.Months)
	for _, p := range r.Series {
		if p.Forecast {
			continue
		}
		fmt.Fprintf(&b, "  %s  cost=%.2f  counterfactual=%.2f\n", p.YearMonth, p.CostEstimate, p.CounterfactualCost)
	}
	fmt.Fprintln(&b, "\nTOP CLUSTERS THIS MONTH:")
	for i, c := range r.Clusters {
		if i >= 8 {
			break
		}
		mom := "—"
		if c.HasMoMBase {
			mom = fmt.Sprintf("%+.1f%%", c.MoMDelta)
		}
		fmt.Fprintf(&b, "  %s  cost=%.2f  mom=%s\n", c.Name, c.CostEstimate, mom)
	}
	b.WriteString("\nReturn ONLY the JSON object.\n")

	raw, aerr := chatter.JSONChat(cctx, b.String())
	if aerr != nil {
		return "", "", false
	}
	var parsed out
	if err := json.Unmarshal([]byte(extractJSONObject(raw)), &parsed); err != nil {
		return "", "", false
	}
	return strings.TrimSpace(parsed.Narrative), provider.Name(), parsed.Narrative != ""
}
