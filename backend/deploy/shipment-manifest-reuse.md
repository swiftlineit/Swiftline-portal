# Shipment manifest reuse index migration

Staff account and staff combined manifests now allow a shipment in multiple manifests. Client account manifests still allow one manifest per shipment. The old unique index on `(tenantId, shipmentDraftIds, actorRole, manifestType)` must be replaced before staff repeat creation works in a deployed database. The migration creates a client-only unique index first, then removes only recognized old membership unique indexes. It does not rewrite manifests or shipment drafts.

1. Review a database backup and pause shipment-manifest creation and deletion for the short index change window. Use a release commit containing the new application and migration code.
2. Run the read-only preflight from `backend` with the expected database and cluster host:

   ```text
   npm run audit:shipment-manifest-reuse-indexes -- --database swiftline --cluster-host <approved-host>
   ```

3. In production, provide separate `TENANT_AUDIT_MONGODB_URI` and `TENANT_MIGRATION_MONGODB_URI` users and the configured `TENANT_MIGRATION_ALLOWED_CLUSTER_HOST`. Apply manually with the reviewed backup and release references:

   ```text
   npm run migrate:shipment-manifest-reuse-indexes -- --database swiftline --cluster-host <approved-host> --change-id <id> --backup-ref <backup> --run-id <id> --artifact-sha <release-sha> --confirm "APPLY SWIFTLINE TENANT MIGRATION swiftline" --log-file <absolute-log-path-outside-checkout>
   ```

4. Run the read-only preflight again. It should report `clientIndexReady: true`, no legacy unique indexes, and no findings. Resume shipment-manifest writes, then verify repeat staff account and combined creation and the client one-manifest limit.

Production application is not part of normal server startup or deployment. Once staff repeats exist, the old unique index cannot be recreated until those repeats are removed.
