// -----------------------------------------------------------------------------
// Attachment smoke test — real S3 upload + document content-block round-trip.
//
// LIVE: performs a real S3 PutObject to the Partner Central ephemeral,
// write-only bucket and one read-only sendMessage turn that references the
// uploaded document. Does not mutate Partner Central (the prompt asks only
// for a summary, so no write/approval is proposed).
//
// Designed to surface the attachment-specific failure modes precisely:
//   - S3 not configured            -> clean SKIP (no failure); text chat orgs
//   - S3 credential / IAM denied    -> AuthenticationException on upload
//   - bucket versioning disabled    -> ClientException (missing versionId)
//   - wrong account id / bucket     -> non-2xx on upload
//
// Step A isolates the S3 PutObject so credential/IAM/versioning errors are
// attributed to the upload layer, not the agent. Step B then drives the full
// submitMessage path so the `document` content block is proven end to end.
// -----------------------------------------------------------------------------

String s3Cred = ConfigProvider.getS3NamedCredentialName();
String bucket = ConfigProvider.getS3BucketName();
String acct   = ConfigProvider.getAwsAccountId();

if (String.isBlank(s3Cred) || String.isBlank(bucket) || String.isBlank(acct)) {
    System.debug('TIER_ATTACH_SKIP | S3 upload not configured. Set the '
        + 'AWS_Partner_Central_S3 Named Credential, S3_Bucket_Name__c, and '
        + 'Aws_Account_Id__c to test attachments. Text chat is unaffected.');
    return;
}

String catalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';

// A tiny, allowed text/plain document.
AttachmentDto att = new AttachmentDto();
att.fileName = 'smoke-note.txt';
att.mimeType = 'text/plain';
String docBody = 'Smoke test attachment. Customer: Acme Cloud Solutions. '
    + 'Budget: 12000 USD per month. Use case: data warehouse migration to AWS.';
Blob raw = Blob.valueOf(docBody);
att.base64Content = EncodingUtil.base64Encode(raw);
att.sizeBytes = raw.size();

// Step A — isolate the S3 upload.
String s3Uri;
try {
    s3Uri = new McpClient().uploadAttachmentToS3(att);
} catch (Exception e) {
    System.debug('TIER_ATTACH_UPLOAD_FAILED | ' + e.getTypeName()
        + ': ' + e.getMessage());
    throw e;
}
System.assert(s3Uri != null && s3Uri.startsWith('s3://'),
    'uploadAttachmentToS3 must return an s3:// URI');
System.assert(s3Uri.contains('versionId='),
    'returned s3Uri must include a versionId (is bucket versioning enabled?)');
System.debug('upload-ok | ' + s3Uri);

// Step B — full round-trip: submitMessage uploads + sends a document block.
// Read-only prompt so no write is proposed.
String message = 'Briefly summarize the attached document in one sentence. '
    + 'Do not create or update anything.';
ChatAgentResult r = ChatAgentController.submitMessage(
    null, null, message, new List<AttachmentDto>{ att }, catalog
);
System.debug('submitMessage.ok=' + r.ok
    + ' errorCode=' + r.errorCode
    + ' errorMessage=' + r.errorMessage);
if (r.ok != true) {
    throw new CalloutException('attachment submitMessage failed: code='
        + r.errorCode + ' msg=' + r.errorMessage);
}

Map<String, Object> payload = (Map<String, Object>) r.payload;
System.assertNotEquals(null, payload, 'payload must be non-null on success');
List<Object> events = (List<Object>) payload.get('events');
System.assert(events != null && events.size() > 0,
    'expected a non-empty events array from the document round-trip');
System.debug('events.count=' + events.size());

System.debug('TIER_ATTACH_OK');
