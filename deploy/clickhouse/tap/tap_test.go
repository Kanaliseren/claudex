package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// deliver mirrors the C glue: reserve first, then hand over the payload.
func deliver(tp *tap, method string, payload []byte) []byte {
	if forwarded[method] && !tp.reserve(len(payload)) {
		return emptyResult
	}
	return tp.call(method, payload)
}

func register(t *testing.T, tp *tap, socket string, hostSchema uint32) map[string]any {
	t.Helper()
	req, _ := json.Marshal(map[string]any{"config_yaml": []byte("enabled: true\nsocket: \"" + socket + "\"\n"), "schema_version": hostSchema})
	var env struct {
		OK     bool           `json:"ok"`
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(tp.call("plugin.register", req), &env); err != nil || !env.OK {
		t.Fatalf("register reply: %v %+v", err, env)
	}
	return env.Result
}

type collector struct {
	ln net.Listener
	r  *bufio.Reader
}

func listen(t *testing.T) (string, *collector) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "tap.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return socket, &collector{ln: ln}
}

func (c *collector) next(t *testing.T) (string, string) {
	t.Helper()
	if c.r == nil {
		conn, err := c.ln.Accept()
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		c.r = bufio.NewReader(conn)
	}
	var size uint32
	if err := binary.Read(c.r, binary.BigEndian, &size); err != nil {
		t.Fatalf("read frame: %v", err)
	}
	frame := make([]byte, size)
	if _, err := io.ReadFull(c.r, frame); err != nil {
		t.Fatalf("read frame: %v", err)
	}
	m := int(frame[0])
	return string(frame[1 : 1+m]), string(frame[1+m:])
}

func TestForwardsHooksInOrderAndRepliesEmpty(t *testing.T) {
	socket, col := listen(t)
	tp := newTap()
	defer tp.shutdown()

	reg := register(t, tp, socket, 10)
	if got := reg["schema_version"]; got != float64(7) {
		t.Fatalf("schema_version = %v, want 7 on a newer host", got)
	}
	// The host rejects a plugin unless all of these are set (pluginhost validPlugin).
	meta, _ := reg["metadata"].(map[string]any)
	for _, field := range []string{"Name", "Version", "Author", "GitHubRepository"} {
		if s, _ := meta[field].(string); s == "" {
			t.Fatalf("metadata.%s is empty", field)
		}
	}
	for _, m := range []string{"request.intercept_before", "request.intercept_after", "response.intercept_stream_chunk", "request.complete"} {
		if reply := deliver(tp, m, []byte(`{"m":"`+m+`"}`)); string(reply) != string(emptyResult) {
			t.Fatalf("%s reply = %s", m, reply)
		}
	}
	for _, want := range []string{"tap.hello", "request.intercept_before", "response.intercept_stream_chunk", "request.complete"} {
		if method, _ := col.next(t); method != want {
			t.Fatalf("frame method = %s, want %s", method, want)
		}
	}
}

func TestOlderHostGetsItsOwnSchema(t *testing.T) {
	tp := newTap()
	defer tp.shutdown()
	if got := register(t, tp, "", 6)["schema_version"]; got != float64(6) {
		t.Fatalf("schema_version = %v, want 6", got)
	}
}

func TestNoCollectorNeverBlocksAndStaysBounded(t *testing.T) {
	tp := newTap()
	defer tp.shutdown()
	register(t, tp, filepath.Join(t.TempDir(), "missing.sock"), 7)
	chunk := []byte(strings.Repeat("x", 1<<20))
	start := time.Now()
	for i := 0; i < 2*maxPendingBytes>>20; i++ {
		deliver(tp, "response.intercept_stream_chunk", chunk)
		tp.mu.Lock()
		pending := tp.pending
		tp.mu.Unlock()
		if pending > maxPendingBytes {
			t.Fatalf("pending %d bytes exceeds the bound", pending)
		}
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("hooks took %v without a collector", elapsed)
	}
	if tp.reserve(maxPendingBytes + 1) {
		t.Fatal("an oversized payload was admitted")
	}
}

func TestDropsAreAnnouncedOnceTheCollectorReturns(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "tap.sock")
	tp := newTap()
	defer tp.shutdown()
	register(t, tp, socket, 7)
	deliver(tp, "request.intercept_before", []byte(`{}`))
	// Without a listener the batch (hello + event) is dropped and counted.
	waitFor(t, func() bool { tp.mu.Lock(); defer tp.mu.Unlock(); return tp.lost >= 2 })

	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	col := &collector{ln: ln}
	deliver(tp, "request.complete", []byte(`{}`))
	if method, payload := col.next(t); method != "tap.dropped" || !strings.Contains(payload, `"events":2`) {
		t.Fatalf("first frame = %s %s, want the drop announcement", method, payload)
	}
	if method, _ := col.next(t); method != "request.complete" {
		t.Fatalf("frame = %s, want request.complete", method)
	}
}

func TestShutdownReleasesEverythingAndReloadWorks(t *testing.T) {
	tp := newTap()
	register(t, tp, filepath.Join(t.TempDir(), "missing.sock"), 7)
	for i := 0; i < 10; i++ {
		deliver(tp, "request.intercept_before", []byte(strings.Repeat("y", 1<<10)))
	}
	tp.shutdown()
	tp.mu.Lock()
	queued, running := len(tp.queue), tp.running
	tp.mu.Unlock()
	if queued != 0 || running {
		t.Fatalf("after shutdown: %d queued, writer running %v", queued, running)
	}
	if deliver(tp, "request.intercept_before", []byte("z")); len(tp.queue) != 0 {
		t.Fatal("a closed tap admitted an event")
	}

	// The host keeps the library mapped and may register it again.
	socket, col := listen(t)
	register(t, tp, socket, 7)
	defer tp.shutdown()
	// Events lost while the tap was closed are announced before anything new.
	if method, _ := col.next(t); method != "tap.dropped" {
		t.Fatalf("first frame after reload = %s, want tap.dropped", method)
	}
	if method, _ := col.next(t); method != "tap.hello" {
		t.Fatalf("frame after reload = %s, want tap.hello", method)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
