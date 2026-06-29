/**
 * Feature: partner-central-chat-agent
 *
 * Client-safe subset of `Chat_Agent_Config__mdt` exposed to the LWC.
 *
 * Only the fields the LWC actually needs (attachment ceiling, allowed MIME
 * types for client-side pre-validation, and sandbox flag for the banner) are
 * forwarded. Named Credential names, timeouts, and retention settings stay
 * server-side so they can't be exfiltrated via DOM inspection.
 *
 * See requirements 8.4, 13.2.
 */
public with sharing class ConfigDto {

    @AuraEnabled public Integer maxAttachmentSizeBytes;
    @AuraEnabled public List<String> allowedMimeTypes;
    @AuraEnabled public Boolean isSandbox;

    /** No-arg constructor required for `JSON.deserialize` round-tripping. */
    public ConfigDto() {}
}
