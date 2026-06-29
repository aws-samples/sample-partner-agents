/**
 * Feature: partner-central-chat-agent
 *
 * JSON-RPC 2.0 request value class.
 *
 * Public fields (not getters/setters) are used deliberately so Apex's built-in
 * `JSON.serialize` / `JSON.deserialize` can round-trip instances without custom
 * marshaling. Structural `equals` / `hashCode` are provided so property-based
 * round-trip tests can compare the parsed-and-reserialized result to the
 * original without relying on reference equality.
 *
 * See requirements 3.1, 3.3, 3.6.
 */
public with sharing class JsonRpcRequest {

    /** JSON-RPC protocol version; always "2.0" for a compliant request. */
    public static final String JSONRPC_VERSION = '2.0';

    // Public instance fields (JSON.serialize / JSON.deserialize target these directly).
    public String jsonrpc;
    public String id;
    public String method;
    public Map<String, Object> params;

    /**
     * No-arg constructor required by `JSON.deserialize`. Seeds `jsonrpc` with
     * the protocol constant so callers that build a request manually and
     * forget to set it still produce a valid payload.
     */
    public JsonRpcRequest() {
        this.jsonrpc = JSONRPC_VERSION;
    }

    /** Full-args constructor. Always stamps `jsonrpc` with the protocol constant. */
    public JsonRpcRequest(String id, String method, Map<String, Object> params) {
        this.jsonrpc = JSONRPC_VERSION;
        this.id = id;
        this.method = method;
        this.params = params;
    }

    /**
     * Returns a new Map<String, Object> representation of this request. Useful
     * when callers want to mutate the structure (e.g. redact fields for audit
     * logging) without touching the original object.
     */
    public Map<String, Object> toMap() {
        return new Map<String, Object>{
            'jsonrpc' => this.jsonrpc,
            'id' => this.id,
            'method' => this.method,
            'params' => this.params
        };
    }

    /**
     * Structural equality. `params` is compared via canonical JSON serialization
     * because Apex Map/List reference equality is not sufficient for round-trip
     * property tests.
     */
    public Boolean equals(Object obj) {
        if (obj == null) { return false; }
        if (!(obj instanceof JsonRpcRequest)) { return false; }
        JsonRpcRequest other = (JsonRpcRequest) obj;
        return stringsEqual(this.jsonrpc, other.jsonrpc)
            && stringsEqual(this.id, other.id)
            && stringsEqual(this.method, other.method)
            && JSON.serialize(this.params) == JSON.serialize(other.params);
    }

    /** Hash derived from the same fields used by `equals`, so the contract holds. */
    public Integer hashCode() {
        String composite =
            String.valueOf(this.jsonrpc) + '|' +
            String.valueOf(this.id) + '|' +
            String.valueOf(this.method) + '|' +
            JSON.serialize(this.params);
        return composite.hashCode();
    }

    /** Null-safe String comparison used internally by `equals`. */
    private static Boolean stringsEqual(String a, String b) {
        if (a == null && b == null) { return true; }
        if (a == null || b == null) { return false; }
        return a.equals(b);
    }
}
