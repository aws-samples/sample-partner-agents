/**
 * Feature: partner-central-chat-agent
 *
 * Full chat transcript for a session, including the record context the chat
 * is anchored to and whether the session is running against a sandbox
 * endpoint (which drives the visible banner in the LWC, Req 13.2).
 *
 * `entries` is eagerly initialised to an empty list so the wire payload never
 * contains a null collection.
 *
 * See requirements 1.3, 13.2.
 */
public with sharing class TranscriptDto {

    @AuraEnabled public String sessionId;
    @AuraEnabled public List<TranscriptEntryDto> entries;
    @AuraEnabled public String recordId;
    @AuraEnabled public String objectApiName;
    @AuraEnabled public Boolean isSandbox;

    /**
     * No-arg constructor. Defaults `entries` to an empty list and `isSandbox`
     * to false so deserialized instances always have safe non-null values.
     */
    public TranscriptDto() {
        this.entries = new List<TranscriptEntryDto>();
        this.isSandbox = false;
    }

    /**
     * Builds an empty transcript seeded with the record context and sandbox
     * flag. Useful for first-turn responses when no entries exist yet.
     */
    public static TranscriptDto empty(String recordId, String objectApiName, Boolean isSandbox) {
        TranscriptDto dto = new TranscriptDto();
        dto.recordId = recordId;
        dto.objectApiName = objectApiName;
        dto.isSandbox = isSandbox == null ? false : isSandbox;
        return dto;
    }
}
