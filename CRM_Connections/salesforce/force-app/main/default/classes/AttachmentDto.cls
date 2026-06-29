/**
 * Feature: partner-central-chat-agent
 *
 * Attachment data-transfer object.
 *
 * Carries a user-uploaded file across the LWC <-> Apex boundary before it is
 * redacted for audit logging. `base64Content` is the full payload and MUST be
 * stripped (replaced by the hash in `AttachmentRefDto`) prior to any
 * persistence (see Req 8.4, 10.3).
 *
 * Public `@AuraEnabled` properties with explicit `{ get; set; }` are used so
 * the Lightning framework can deserialize instances passed FROM the LWC INTO
 * Apex (the `submitMessage` `attachments` param). Plain `@AuraEnabled public`
 * fields serialize fine outbound (Apex -> LWC) but deserialize to null fields
 * inbound (LWC -> Apex), which surfaced as `Attachment "null" has no MIME
 * type`. The getter/setter form is required for the inbound direction.
 *
 * See requirements 1.3, 8.4, 10.3.
 */
public with sharing class AttachmentDto {

    @AuraEnabled public String fileName { get; set; }
    @AuraEnabled public String mimeType { get; set; }
    @AuraEnabled public Integer sizeBytes { get; set; }
    @AuraEnabled public String base64Content { get; set; }

    /** No-arg constructor required for `JSON.deserialize` round-tripping. */
    public AttachmentDto() {}
}
