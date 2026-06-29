/**
 * Feature: partner-central-chat-agent
 *
 * Redacted attachment reference used in audit logs and persisted transcripts.
 *
 * Stores only the metadata and a SHA-256 hash of the original bytes so the
 * content itself never lands in `Audit_Log__c` or `Chat_Session__c.Transcript_Json__c`
 * (Req 8.4). `fromAttachment` computes the hash directly from the base64
 * payload on the inbound `AttachmentDto` so callers cannot accidentally log
 * the raw bytes.
 *
 * See requirements 1.3, 8.4, 10.3.
 */
public with sharing class AttachmentRefDto {

    @AuraEnabled public String fileName;
    @AuraEnabled public String mimeType;
    @AuraEnabled public Integer sizeBytes;
    @AuraEnabled public String sha256;

    /** No-arg constructor required for `JSON.deserialize` round-tripping. */
    public AttachmentRefDto() {}

    /**
     * Builds a redacted reference from an inbound `AttachmentDto`, copying the
     * metadata fields and replacing `base64Content` with a SHA-256 hex digest.
     * Returns null when the source attachment is null. When `base64Content` is
     * null the reference is still produced but `sha256` is left null.
     */
    public static AttachmentRefDto fromAttachment(AttachmentDto att) {
        if (att == null) { return null; }
        AttachmentRefDto ref = new AttachmentRefDto();
        ref.fileName = att.fileName;
        ref.mimeType = att.mimeType;
        ref.sizeBytes = att.sizeBytes;
        if (att.base64Content != null) {
            Blob decoded = EncodingUtil.base64Decode(att.base64Content);
            ref.sha256 = EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', decoded));
        } else {
            ref.sha256 = null;
        }
        return ref;
    }
}
