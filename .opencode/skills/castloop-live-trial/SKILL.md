---
name: Castloop Live Trial
description: Use when preparing or running private castloop trials against a live Cloudflare account, including deployment, sample publication, reviewer access checks, and trial cleanup.
---

# Castloop Live Trial

## Read the common requirements

Before preparing commands or changing resources, read:

1. [Live operation boundaries](../../../design/live-operations.md): authorization and protected resources.
2. [Private trial requirements](../../../design/security.md#非公開の実機試験): access protection and stopping conditions.

## Select the scenario

Identify what the requested trial must verify. Use the [standard scenario](../../../design/live-trial.md#適用範囲) when the task calls for a fresh service, a Show and three Episodes using the existing trial assets. For another purpose, use a matching procedure; if none exists, describe the focused operations and expected results before obtaining authorization. Do not add the standard scenario's full publication sequence to every trial.

Every scenario must satisfy the common protection requirements. The chosen procedure owns its commands, assets and functional checks; this skill selects the procedure rather than duplicating it.

## Confirm the authorized scope

Identify the target account, resource names, reviewer, sample content and approved operations before execution. A request to prepare a trial permits preparation, not live changes. Loading this skill or finding past trial evidence is not authorization.

Prior evidence can supply candidate values, not current approval. Reconfirm the target, reviewer and access configuration for this trial. Preserve the protected resources listed in the live operation boundaries and confirm current state through the API before changing resources. If the target or authorization is unclear, stop and ask before the affected operation.

## Run and verify the trial

Follow the chosen procedure within the approved scope. Verify the required access protection before uploading or publishing sample content; stop if protection cannot be verified. Preserve administrator-key authentication and perform the common anonymous-denial checks after deployment and publication.

Keep local originals and private evidence intact. Cleanup requires explicit authorization for the resources or local evidence being removed; trial execution is not blanket permission to delete them.

Record and report the tested revision, performed operations, verification results and missing evidence using the documented privacy rules. Separate local results, live measurements and reviewer confirmation; claim only what was verified.
