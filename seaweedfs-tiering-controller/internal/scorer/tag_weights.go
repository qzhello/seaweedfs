package scorer

// Travel-industry default weight overrides per business domain. Each map
// patches the base weights from config; missing keys keep the base value.
//
// Why per-domain weights?
//   - flight/train/car: 出行后骤冷,放大 quiet_for_days
//   - hotel/attraction: 长尾,缩小 quiet_for_days,放大 access_count
//   - logs: 写后只读,直接看 size + readonly
//   - finance: 合规留存,只在极冷时才动 → 全部权重缩小 + 高阈值
var DomainWeights = map[string]map[string]float64{
	"flight": {
		"last_access_decay": 0.30,
		"access_count_30d":  0.15,
		"quiet_for_days":    0.35, // 出行后冷得快
		"is_readonly":       0.15,
		"object_size":       0.05,
	},
	"train": {
		"last_access_decay": 0.30,
		"access_count_30d":  0.15,
		"quiet_for_days":    0.35,
		"is_readonly":       0.15,
		"object_size":       0.05,
	},
	"car_rental": {
		"last_access_decay": 0.25,
		"access_count_30d":  0.15,
		"quiet_for_days":    0.40,
		"is_readonly":       0.15,
		"object_size":       0.05,
	},
	"hotel": {
		"last_access_decay": 0.50, // 长尾, 看最近访问
		"access_count_30d":  0.30,
		"quiet_for_days":    0.05,
		"is_readonly":       0.10,
		"object_size":       0.05,
	},
	"attraction": {
		"last_access_decay": 0.50,
		"access_count_30d":  0.30,
		"quiet_for_days":    0.05,
		"is_readonly":       0.10,
		"object_size":       0.05,
	},
	"logs": {
		"last_access_decay": 0.20,
		"access_count_30d":  0.10,
		"quiet_for_days":    0.20,
		"is_readonly":       0.30,
		"object_size":       0.20, // 日志体积是关键
	},
	"finance": { // 合规, 极保守
		"last_access_decay": 0.10,
		"access_count_30d":  0.10,
		"quiet_for_days":    0.10,
		"is_readonly":       0.40,
		"object_size":       0.30,
	},
	"backup": {
		"last_access_decay": 0.15,
		"access_count_30d":  0.05,
		"quiet_for_days":    0.30,
		"is_readonly":       0.30,
		"object_size":       0.20,
	},
}

// DomainThresholdShift adjusts decision thresholds per domain.
// Positive value = stricter (must be colder to trigger). Negative = more eager.
var DomainThresholdShift = map[string]float64{
	"flight":     -0.05, // 票务可以更激进
	"train":      -0.05,
	"car_rental": -0.05,
	"hotel":      0.10,  // 头部不能轻易降冷
	"attraction": 0.10,
	"logs":       -0.10, // 日志最激进
	"finance":    0.20,  // 合规最严格
	"backup":     0.00,
	"other":      0.00,
}

// ApplyDomainOverride returns a fresh weights/thresholds pair with the
// per-domain patch applied. Caller passes the base config.
func ApplyDomainOverride(base map[string]float64, thresholds map[string]float64, domain string) (map[string]float64, map[string]float64) {
	w := map[string]float64{}
	for k, v := range base {
		w[k] = v
	}
	if patch, ok := DomainWeights[domain]; ok {
		for k, v := range patch {
			w[k] = v
		}
	}
	t := map[string]float64{}
	for k, v := range thresholds {
		t[k] = v
	}
	if shift, ok := DomainThresholdShift[domain]; ok {
		for k := range t {
			t[k] = clampShift(t[k] + shift)
		}
	}
	return w, t
}

func clampShift(x float64) float64 {
	if x < 0.10 {
		return 0.10
	}
	if x > 0.99 {
		return 0.99
	}
	return x
}
