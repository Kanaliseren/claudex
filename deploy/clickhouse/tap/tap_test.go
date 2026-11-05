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

func readFrame(t *testing.T, r *bufio.Reader) (string, string) {
	t.Helper()
	var size uint32
	if err := binary.Read(r, binary.BigEndian, &size); err != nil {
		t.Fatalf("read frame: %v", err)
	}
	frame := make([]byte, size)
	if _, err := io.ReadFull(r, frame); err != nil {
		t.Fatalf("read frame: %v", err)
	}
	m := int(frame[0])
	return string(frame[1 : 1+m]), string(frame[1+m:])
}

func TestForwardsHooksInOrderAndRepliesEmpty(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "tap.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
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
		if reply := tp.call(m, []byte(`{"m":"`+m+`"}`)); string(reply) != string(emptyResult) {
			t.Fatalf("%s reply = %s", m, reply)
		}
	}

	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)
	want := []string{"tap.hello", "request.intercept_before", "response.intercept_stream_chunk", "request.complete"}
	for _, w := range want {
		if method, _ := readFrame(t, r); method != w {
			t.Fatalf("frame method = %s, want %s", method, w)
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
	for i := 0; i < 2*maxQueuedBytes>>20; i++ {
		tp.call("response.intercept_stream_chunk", chunk)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("hooks took %v without a collector", elapsed)
	}
	tp.mu.Lock()
	queued, dropped := tp.queued, tp.dropped
	tp.mu.Unlock()
	if queued > maxQueuedBytes || queued+int(dropped)<<20 < maxQueuedBytes {
		t.Fatalf("queued %d bytes, dropped %d events", queued, dropped)
	}
}
