-- Bindings use the existing JSON payload; never infer identity for old requests.
UPDATE approvals
SET state = 'expired',
    payload = json_set(payload, '$.state', 'expired',
      '$.expiryReason', 'legacy-acp-binding-missing',
      '$.decisionActor', 'migration-0006')
WHERE boundary = 'acp-permission' AND state = 'pending'
  AND json_type(payload, '$.acp') IS NULL;
