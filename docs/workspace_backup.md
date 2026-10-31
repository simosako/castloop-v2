# Workspace backup and restore

Save your configuration, administrator keys, and editable show files in an encrypted backup. Use it when moving to another management device or restoring local files.

## 1. Check what to save

The backup includes:

| Files | Contents |
| --- | --- |
| `castloop.toml`, `castloop-admin.toml` | Service and administrator configuration |
| Administrator keys and corresponding operation records in `.castloop/` | Information used to administer the service |
| TOML, cover images, CSS, and similar files directly inside show folders | Local editable files |
| MP3 files directly inside show folders | Included when `--include-audio` is specified |

This backup covers the local workspace. Save original audio outside show folders and in-progress RSS import folders separately.

## 2. Create a backup

Finish editing and running commands in the workspace, then specify a new output path:

```sh
castloop backup-create --workspace /path/to/workspace --output /path/to/backup.clbk
```

Enter a passphrase when prompted. You will need it to restore the backup, so store it securely and separately from the backup file.

To include MP3 files directly inside show folders, add `--include-audio`:

```sh
castloop backup-create --workspace /path/to/workspace --output /path/to/backup-with-audio.clbk --include-audio
```

Review the lists of included and excluded files in the result. Save any excluded originals you need separately.

## 3. Verify the backup

```sh
castloop backup-verify /path/to/backup.clbk
```

Enter the passphrase used to create it. Check file integrity and `config_valid` in the verification result, then copy the verified backup to a secure location.

Create a new backup whenever you change administrator keys, configuration, or editable files.

## 4. Restore to a new location

First preview the restore. Specify a destination folder that does not yet exist:

```sh
castloop backup-restore-preview /path/to/backup.clbk --dest /path/to/new-workspace
```

Check the destination and file list, then restore. Enter `confirm` exactly as shown:

```sh
castloop backup-restore /path/to/backup.clbk /path/to/new-workspace confirm
castloop doctor --local --workspace /path/to/new-workspace
```

Once you have checked the administrator keys and configuration in the restored workspace, you can continue managing the service from there.

If there are unfinished operation records, check the current status using [the interruption guide](troubleshooting.md#when-an-operation-is-interrupted) before continuing.

## Automated use

When using `--json` or `--non-interactive`, save the passphrase in a UTF-8 file and add `--passphrase-file /path/to/pass.txt`. Protect the file so only you can read it.
