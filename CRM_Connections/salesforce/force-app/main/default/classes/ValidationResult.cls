/**
 * Feature: partner-central-chat-agent
 *
 * Result envelope returned by `AttachmentValidator` (and any future pure
 * validator in this feature). On success, `ok` is `true` and the other
 * fields are `null`. On failure, `ok` is `false`, `violatedRule` names the
 * specific rule that failed (one of the `RULE_*` constants), and `message`
 * carries a human-readable explanation suitable for surfacing to the end
 * user via the LWC error banner (Req 7.3).
 *
 * The `RULE_*` constants are the canonical vocabulary the LWC/controller
 * can branch on; callers MUST prefer them over bare string literals so
 * upstream error mapping stays in sync.
 *
 * See requirements 7.1, 7.2, 7.3.
 */
public with sharing class ValidationResult {

    // Canonical violated-rule codes (design doc vocabulary).
    public static final String RULE_MIME_TYPE = 'MIME_TYPE_NOT_ALLOWED';
    public static final String RULE_SIZE = 'SIZE_EXCEEDS_MAX';
    public static final String RULE_NULL_ATTACHMENT = 'ATTACHMENT_IS_NULL';
    public static final String RULE_MISSING_MIME_TYPE = 'MIME_TYPE_MISSING';
    public static final String RULE_MISSING_SIZE = 'SIZE_MISSING';

    @AuraEnabled public Boolean ok;
    @AuraEnabled public String violatedRule;
    @AuraEnabled public String message;

    /** No-arg constructor required for `JSON.deserialize` round-tripping. */
    public ValidationResult() {}

    /** Builds a success result (`ok = true`, rule/message left null). */
    public static ValidationResult success() {
        ValidationResult r = new ValidationResult();
        r.ok = true;
        return r;
    }

    /**
     * Builds a failure result carrying the canonical `violatedRule` code and
     * a human-readable `message`. Callers should prefer the `RULE_*`
     * constants above for `rule` so LWC-side branching stays stable.
     */
    public static ValidationResult failure(String rule, String message) {
        ValidationResult r = new ValidationResult();
        r.ok = false;
        r.violatedRule = rule;
        r.message = message;
        return r;
    }
}
