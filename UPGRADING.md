# Upgrading

The control-plane image and the machine image share one version. Replacing the control-plane container is enough when the machine image digest is unchanged. Rebuild a user's machine only when that digest changes, or when this file says the protocol requires it.

A new machined binary exists only in newly created containers. Building an image without rebuilding an existing machine leaves the old process running.

## Steps

1. Stop the control plane. For published images, pull both new version tags and update the control-plane container tag; its built-in machine default points at the matching new release. If you set `VB_MACHINE_IMAGE`, update it too and pull that image. For source builds, update the checkout and build both images with the desired tag. Do not delete `VB_DATA_DIR`.
2. Start the control plane again.
3. Rebuild each existing machine whose image digest changed: the admin Machines page **重建**, or `POST /api/admin/machines/<machineId>/rebuild`. That deletes the old container and uses the control plane's currently configured machine image, not the old machine row's tag. The volume is kept. The call is rejected while a task is unfinished. If the machine was stopped or in error, start it after rebuilding; a compatible health check clears `status_detail` and restores normal operation.
4. With `VB_DEV=1`, the same action is `pnpm --filter @viate-bot/control machine rebuild <userId>`.
5. When the firewall scripts change, install them again and run the checks in [deploy/rancher-desktop/README.md](deploy/rancher-desktop/README.md). Replacing the files without re-running provisioning does nothing.

Published images default `VB_MACHINE_IMAGE` to `ghcr.io/viateai/viate-bot-machine` at the same tag. Override it with the environment variable when you mirror the images.

## Machine protocol

machined reports its compiled-in `MACHINE_PROTOCOL_VERSION` as `protocol` on `GET /health`. Environment variables cannot override this protocol. The machine image label `ai.viate.bot.machine-protocol` is informational and must match that constant at build time; the control plane checks the authenticated health response, not that label. The control plane accepts the reported integer only when it is inside the range it was built with. A health body that omits `protocol` is protocol 1, so machines built before the field existed keep working on a control plane that still accepts 1.

If the reported version is outside the range, the control plane does not use the machine. The admin Machines page and the user's task error both say `机器镜像协议版本 X，控制面需要 Y，请重建机器`. An audit row `machine.protocol` records it. Rebuild the machine after you have deployed an image that speaks a supported version.

A commit that changes `MACHINE_PROTOCOL_VERSION` in `packages/protocol` must update the table below in the same commit.

| Protocol | Rebuild required |
| --- | --- |
| 1 | First protocol. No rebuild for machines that omit the field or report 1. |
