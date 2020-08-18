package filer2

import (
	"fmt"
	"io"
	"math"
	"strconv"
	"sync"
	"testing"
)

type mockChunkCache struct {
}

func (m *mockChunkCache) GetChunk(fileId string, minSize uint64) (data []byte) {
	x, _ := strconv.Atoi(fileId)
	data = make([]byte, minSize)
	for i := 0; i < int(minSize); i++ {
		data[i] = byte(x)
	}
	return data
}
func (m *mockChunkCache) SetChunk(fileId string, data []byte) {
}

func TestReaderAt(t *testing.T) {

	visibles := []VisibleInterval{
		{
			start:  1,
			stop:   2,
			fileId: "1",
			chunkSize: 9,
		},
		{
			start:  3,
			stop:   4,
			fileId: "3",
			chunkSize: 1,
		},
		{
			start:  5,
			stop:   6,
			fileId: "5",
			chunkSize: 2,
		},
		{
			start:  7,
			stop:   9,
			fileId: "7",
			chunkSize: 2,
		},
		{
			start:  9,
			stop:   10,
			fileId: "9",
			chunkSize: 2,
		},
	}

	readerAt := &ChunkReadAt{
		chunkViews:   ViewFromVisibleIntervals(visibles, 0, math.MaxInt64),
		lookupFileId: nil,
		readerLock:   sync.Mutex{},
		fileSize:     10,
		chunkCache:   &mockChunkCache{},
	}

	testReadAt(t, readerAt, 0, 10, 10, io.EOF)
	testReadAt(t, readerAt, 0, 12, 10, io.EOF)
	testReadAt(t, readerAt, 2, 8, 8, io.EOF)
	testReadAt(t, readerAt, 3, 6, 6, nil)

}

func testReadAt(t *testing.T, readerAt *ChunkReadAt, offset int64, size int, expected int, expectedErr error) {
	data := make([]byte, size)
	n, err := readerAt.ReadAt(data, offset)

	if expected != n {
		t.Errorf("unexpected read size: %d, expect: %d", n, expected)
	}
	if err != expectedErr {
		t.Errorf("unexpected read error: %v, expect: %v", err, expectedErr)
	}

	for _, d := range data {
		fmt.Printf("%x", d)
	}
	fmt.Println()
}

func TestReaderAt0(t *testing.T) {

	visibles := []VisibleInterval{
		{
			start:  2,
			stop:   5,
			fileId: "1",
			chunkSize: 9,
		},
		{
			start:  7,
			stop:   9,
			fileId: "2",
			chunkSize: 9,
		},
	}

	readerAt := &ChunkReadAt{
		chunkViews:   ViewFromVisibleIntervals(visibles, 0, math.MaxInt64),
		lookupFileId: nil,
		readerLock:   sync.Mutex{},
		fileSize:     10,
		chunkCache:   &mockChunkCache{},
	}

	testReadAt(t, readerAt, 0, 10, 10, io.EOF)
	testReadAt(t, readerAt, 3, 16, 7, io.EOF)
	testReadAt(t, readerAt, 3, 5, 5, nil)

}
