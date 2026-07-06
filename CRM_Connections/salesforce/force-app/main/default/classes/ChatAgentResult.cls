/**
 * Feature: partner-central-chat-agent
 *
 * Uniform result envelope returned by every `ChatAgentController` method.
 *
 * The LWC inspects `ok` first; on success it reads `payload` (and optionally
 * `transcriptEntryId`), on failure it surfaces `errorCode` / `errorMessage`
 * to the user through the in-component error banner (Req 7.5). The error
 * code constants below are the canonical vocabulary referenced by the
 * design document so the LWC and controller agree on the domain.
 *
 * See requirements 7.5, 8.4, 10.3.
 */
public with sharing class ChatAgentResult {

    // Canonical error codes (design doc vocabulary).
    public static final String ERROR_ACCESS_DENIED = 'ACCESS_DENIED';
    public static final String ERROR_CONFIG_MISSING = 'CONFIG_MISSING';
    public static final String ERROR_ATTACHMENT_INVALID = 'ATTACHMENT_INVALID';
    public static final String ERROR_AUTHENTICATION = 'AUTHENTICATION';
    public static final String ERROR_CLIENT = 'CLIENT_ERROR';
    public static final String ERROR_RETRYABLE = 'RETRYABLE_ERROR';
    public static final String ERROR_TIMEOUT = 'TIMEOUT';
    public static final String ERROR_PARSE = 'PARSE_ERROR';
    public static final String ERROR_JSON_RPC = 'JSON_RPC_ERROR';
    public static final String ERROR_SESSION_EXPIRED = 'SESSION_EXPIRED';
    public static final String ERROR_OPERATION_NOT_FOUND = 'OPERATION_NOT_FOUND';
    public static final String ERROR_INVALID_DECISION = 'INVALID_DECISION';

    @AuraEnabled public Boolean ok;
    @AuraEnabled public String errorCode;
    @AuraEnabled public String errorMessage;
    @AuraEnabled public String transcriptEntryId;
    @AuraEnabled public Object payload;

    /** No-arg constructor required for `JSON.deserialize` round-tripping. */
    public ChatAgentResult() {}

    /**
     * Builds a success envelope carrying the transcript entry id that was
     * created/updated and an arbitrary payload for the caller (e.g. a
     * `TranscriptDto` or a sessionId string).
     */
    public static ChatAgentResult success(String transcriptEntryId, Object payload) {
        ChatAgentResult r = new ChatAgentResult();
        r.ok = true;
        r.transcriptEntryId = transcriptEntryId;
        r.payload = payload;
        return r;
    }

    /**
     * Builds a failure envelope with a canonical error code and human-readable
     * message. Callers should prefer the `ERROR_*` constants above for
     * `errorCode` so LWC-side branching stays in sync with the controller.
     */
    public static ChatAgentResult failure(String errorCode, String errorMessage) {
        ChatAgentResult r = new ChatAgentResult();
        r.ok = false;
        r.errorCode = errorCode;
        r.errorMessage = errorMessage;
        return r;
    }
}
