// Command claudex-tap is a CLIProxyAPI plugin that copies request, response
// and usage events to a local unix socket and does nothing else.
//
// It runs inside the proxy, next to the OAuth tokens, so it is kept tiny and
// dependency-free: every hook copies its payload into a bounded queue and
// returns an empty result at once, which leaves requests and responses
// untouched. A single goroutine writes the queue to the collector. When the
// collector is missing or slow, events are dropped; the proxy never waits and
// its budget never exceeds maxPendingBytes. Redaction, parsing and storage all
// happen in the collector process.
//
// Build: go build -buildmode=c-shared -o claudex-tap.so .
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"unsafe"
)

const abiVersion uint32 = 1

func main() {}

// The host API is not stored: the tap never calls back into the proxy.
//
//export cliproxy_plugin_init
func cliproxy_plugin_init(_ *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	plugin.abi_version = C.uint32_t(abiVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		return 1
	}
	name := C.GoString(method)
	// Only needed payloads are copied, and forwarded ones only after their
	// bytes are reserved, so a payload the tap will drop is never allocated.
	var payload []byte
	if request != nil && requestLen > 0 && current.wants(name) {
		if forwarded[name] && !current.reserve(int(requestLen)) {
			return writeReply(response, emptyResult)
		}
		payload = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	} else if forwarded[name] && !current.reserve(0) {
		return writeReply(response, emptyResult)
	}
	return writeReply(response, current.call(name, payload))
}

func writeReply(response *C.cliproxy_buffer, raw []byte) C.int {
	if response != nil && len(raw) > 0 {
		if ptr := C.CBytes(raw); ptr != nil {
			response.ptr = ptr
			response.len = C.size_t(len(raw))
		}
	}
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	current.shutdown()
}
