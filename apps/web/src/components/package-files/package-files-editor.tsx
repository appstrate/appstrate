// SPDX-License-Identifier: Apache-2.0

/**
 * The authoring surface over a package's DRAFT file tree: the editable tree on
 * the left, the selected file on the right.
 *
 * Two write rhythms, one route. **Structural** gestures — new file, rename,
 * delete, upload, replace — each send one `PATCH .../files` immediately and
 * adopt the tree the response carries, so the server stays the only thing that
 * ever computes a tree shape. **Text** edits are buffered per path and flushed
 * as one batch by the editor's *Enregistrer*, because a request per keystroke
 * would rewrite the package's whole archive per keystroke.
 * `lib/package-file-drafts.ts` owns the place the two rhythms meet.
 *
 * The buffer itself belongs to the package editor above, for one reason: it is
 * half of what "unsaved changes" means, and the blocker that reads it is up
 * there with the manifest. This component stays mounted while the author works
 * on another tab (it renders nothing when `active` is false), because the
 * validator ETag and the file selection are ITS state and a tab switch must not
 * drop them.
 */

import {
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Dispatch,
  type Ref,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, TriangleAlert } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  PACKAGE_FILE_INLINE_MAX_BYTES,
  PACKAGE_MANIFEST_FILE,
} from "@appstrate/core/package-files";
import { formatBytes } from "@appstrate/core/format";
import type { PackageType } from "@appstrate/core/validation";
import {
  isPinnedEntry,
  languageForPath,
  pickActiveEntry,
  previewBlockReason,
  validateNewPath,
  type PackageFileEntry,
  type PackageFileWriteOperation,
} from "../../lib/package-file-tree";
import {
  conflictedDrafts,
  draftWriteOperations,
  dropDraftText,
  renameDraftText,
  setDraftText,
  type DraftText,
  type DraftTexts,
} from "../../lib/package-file-drafts";
import { packageFilesErrorKey, primaryDisplayFile } from "../../lib/package-files";
import { ConfirmModal } from "../confirm-modal";
import { ContentEditor } from "../package-editor/content-editor";
import { LoadingState, ErrorState, EmptyState } from "../page-states";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";
import { FilePathDialog } from "./file-path-dialog";
import { usePackageFile } from "./use-package-file";
import { usePackageDraftFiles } from "./use-package-draft-files";

/** What the package editor drives from its save bar. */
export interface PackageFilesEditorHandle {
  /**
   * Send every buffered text edit as one batch. Resolves to the package row's
   * new `lock_version` — the token the manifest `PUT` must then carry — or
   * `undefined` when nothing was buffered. Rejects with the route's `ApiError`.
   */
  flush: () => Promise<number | undefined>;
  /**
   * The type's content entry as the author currently has it: the buffered text
   * when it is dirty, else the copy the index carries. `undefined` before the
   * index resolves, and for a content entry the index did not inline — the
   * server runs the same check on the bytes it is about to store either way.
   */
  contentEntryText: () => string | undefined;
}

interface PackageFilesEditorProps {
  packageId: string;
  type: PackageType;
  /** False while another tab of the editor is showing — state is kept, nothing renders. */
  active: boolean;
  /** Buffered text edits, owned by the package editor so its blocker can read them. */
  drafts: DraftTexts;
  setDrafts: Dispatch<SetStateAction<DraftTexts>>;
  /** Every write bumps the row's optimistic-lock token; the manifest `PUT` needs the latest. */
  onLockVersion: (lockVersion: number) => void;
  ref?: Ref<PackageFilesEditorHandle>;
}

/** Which dialog is open, and what it is about to act on. */
type Dialog =
  { kind: "create" } | { kind: "rename"; path: string } | { kind: "delete"; path: string } | null;

/** What the next file picker result means. */
type UploadIntent = { kind: "add" } | { kind: "replace"; path: string };

export function PackageFilesEditor({
  packageId,
  type,
  active,
  drafts,
  setDrafts,
  onLockVersion,
  ref,
}: PackageFilesEditorProps) {
  const { t } = useTranslation(["agents", "common"]);
  const files = usePackageDraftFiles(packageId);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // One `<input type=file>` serves *Importer* and *Remplacer*; which gesture
  // opened it is not recoverable from the picked files, so it is recorded here.
  const uploadIntent = useRef<UploadIntent>({ kind: "add" });
  const uploadRef = useRef<HTMLInputElement>(null);
  const paneId = useId();
  // Named once, for both the message this client raises and the one the route
  // raises: the ceiling is the same constant on both ends.
  const limit = formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES);

  const entries = files.entries;
  // The type's content entry, named ONCE for this component: the file the tree
  // opens on, and the one the package editor's frontmatter check reads.
  const contentEntry = primaryDisplayFile(type).name;

  /**
   * Send one batch and report the row's new token. `flush` awaits this directly
   * so a failed save reaches the editor's error banner; the gestures below go
   * through `applyOrToast`, which has no caller to report to.
   */
  const apply = async (operations: PackageFileWriteOperation[]): Promise<number> => {
    const lockVersion = await files.patch(operations);
    onLockVersion(lockVersion);
    return lockVersion;
  };

  const applyOrToast = (operations: PackageFileWriteOperation[], after?: () => void) => {
    void apply(operations).then(
      () => after?.(),
      (error: unknown) => {
        toast.error(t(packageFilesErrorKey(error) ?? "files.errorGeneric", { limit }));
        // A `412` says someone wrote between the read and this request. Re-read
        // the tree so the next attempt carries a live validator — and keep the
        // buffer, which holds the author's unsent work, not the server's.
        //
        // That re-read is also what would DISARM the guard, which is why the
        // buffer carries the bytes it was typed on top of: the next
        // *Enregistrer* would otherwise send text composed against the old tree
        // with a validator for the new one, and the route would accept it.
        // `conflictedDrafts` names the files where that applies; the pane below
        // says so and the author chooses.
        files.reload();
      },
    );
  };

  useImperativeHandle(ref, () => ({
    flush: async () => {
      const operations = draftWriteOperations(drafts);
      if (operations.length === 0) return undefined;
      let lockVersion: number;
      try {
        lockVersion = await apply(operations);
      } catch (error) {
        // The save bar reports this one; here the tree is re-read so the next
        // attempt carries a live validator, and the buffer is kept untouched —
        // it is the work the author is trying to save.
        files.reload();
        throw error;
      }
      setDrafts({});
      return lockVersion;
    },
    contentEntryText: () =>
      drafts[contentEntry]?.text ?? entries?.find((e) => e.path === contentEntry)?.inline,
  }));

  if (!active) return null;
  if (files.isError) return <ErrorState message={t("files.errorLoad")} />;
  if (!entries) return <LoadingState />;

  const activeEntry = pickActiveEntry(entries, selectedPath, contentEntry);
  if (activeEntry === null) {
    return <EmptyState icon={FolderOpen} message={t("files.empty")} compact />;
  }

  const create = (path: string) => {
    setDialog(null);
    applyOrToast([{ op: "write", path, text: "" }], () => setSelectedPath(path));
  };

  const rename = (from: string, to: string) => {
    setDialog(null);
    applyOrToast([{ op: "move", from, to }], () => {
      setDrafts((current) => renameDraftText(current, from, to));
      setSelectedPath((current) => (current === from ? to : current));
    });
  };

  const remove = (path: string) => {
    setDialog(null);
    applyOrToast([{ op: "delete", path }], () => {
      setDrafts((current) => dropDraftText(current, path));
      setSelectedPath((current) => (current === path ? null : current));
    });
  };

  const pickFiles = (intent: UploadIntent) => {
    uploadIntent.current = intent;
    const input = uploadRef.current;
    if (!input) return;
    // *Importer* takes any number of files, *Remplacer* takes the one whose
    // bytes it replaces. The picker is told which before it opens, so a replace
    // cannot end on the browser handing over three files and this dropping two.
    input.multiple = intent.kind === "add";
    input.click();
  };

  /**
   * Turn picked files into one batch of byte writes. Refused wholesale on the
   * first offender: the batch is atomic server-side, so accepting part of a
   * multi-file import here would be the one place the two ends disagree about
   * what "this import" means.
   *
   * Only the two verdicts an import can hit are screened locally. `exists` is
   * NOT one of them — dropping a file over one already in the tree is what
   * importing it again means, and a `write` overwrites by design. `conflict` is
   * left to the route, which rules on the tree as it is at that instant rather
   * than on the index this client last read.
   */
  const upload = async (picked: readonly File[], intent: UploadIntent) => {
    const targets = intent.kind === "replace" ? [{ file: picked[0]!, path: intent.path }] : null;
    const chosen = targets ?? picked.map((file) => ({ file, path: file.name }));
    for (const { file, path } of chosen) {
      if (file.size > PACKAGE_FILE_INLINE_MAX_BYTES) {
        toast.error(t("files.errorTooLarge", { limit }));
        return;
      }
      const rejection = validateNewPath(entries, path);
      if (rejection === "invalid" || rejection === "reserved") {
        toast.error(t(rejection === "invalid" ? "files.errorInvalidPath" : "files.errorReserved"));
        return;
      }
    }
    const operations: PackageFileWriteOperation[] = await Promise.all(
      chosen.map(async ({ file, path }) => ({
        op: "write" as const,
        path,
        bytes_base64: await readAsBase64(file),
      })),
    );
    // Bytes replace a path wholesale, so any text buffered for it is void.
    applyOrToast(operations, () => {
      setDrafts((current) => chosen.reduce((acc, { path }) => dropDraftText(acc, path), current));
      if (intent.kind === "add" && chosen.length === 1) setSelectedPath(chosen[0]!.path);
    });
  };

  const isPinned = (path: string) => isPinnedEntry(type, path);
  // Files a colleague wrote while their text sat unsent here. Saving still
  // writes the author's version — the point is that they see it first.
  const conflicted = conflictedDrafts(drafts, entries);
  // `manifest.json` is authored on the JSON tab and refused by the write route,
  // so it is shown but never opened for typing. Everything else the preview
  // ceiling admits is text.
  const editable =
    activeEntry.path !== PACKAGE_MANIFEST_FILE && previewBlockReason(activeEntry) === null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
      <FileTree
        entries={entries}
        selectedPath={activeEntry.path}
        onSelect={setSelectedPath}
        label={t("files.treeLabel")}
        controlsId={paneId}
        className="border-border bg-card max-h-[560px] rounded-lg border"
        actions={{
          onCreate: () => setDialog({ kind: "create" }),
          onUpload: () => pickFiles({ kind: "add" }),
          onRename: (path) => setDialog({ kind: "rename", path }),
          onDelete: (path) => setDialog({ kind: "delete", path }),
          isPinned,
          isBusy: files.isPatching,
          conflicted,
          labels: {
            newFile: t("files.newFile"),
            upload: t("files.upload"),
            rename: t("files.rename"),
            delete: t("files.delete"),
            conflicted: t("files.conflictedRow"),
          },
        }}
      />

      {editable ? (
        <EditableFilePane
          id={paneId}
          packageId={packageId}
          entry={activeEntry}
          draft={drafts[activeEntry.path]}
          conflicted={conflicted.has(activeEntry.path)}
          onDiscardDraft={() => setDrafts((current) => dropDraftText(current, activeEntry.path))}
          hint={isPinned(activeEntry.path) ? t("files.pinnedHint") : null}
          onChange={(text, serverText) =>
            setDrafts((current) => setDraftText(current, activeEntry.path, text, serverText))
          }
        />
      ) : (
        <FilePreview
          id={paneId}
          packageId={packageId}
          version={undefined}
          entry={activeEntry}
          actions={
            isPinned(activeEntry.path) ? null : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={files.isPatching}
                  onClick={() => pickFiles({ kind: "replace", path: activeEntry.path })}
                >
                  {t("files.replace")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={files.isPatching}
                  onClick={() => setDialog({ kind: "delete", path: activeEntry.path })}
                >
                  {t("files.delete")}
                </Button>
              </>
            )
          }
        />
      )}

      {/* `multiple` is set by `pickFiles` from the gesture that opens this, so
          it is not declared here — one place decides. Reset after every pick so
          choosing the same file twice in a row still fires a change event. */}
      <input
        ref={uploadRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          event.target.value = "";
          if (picked.length > 0) void upload(picked, uploadIntent.current);
        }}
      />

      {dialog?.kind === "create" && (
        <FilePathDialog
          title={t("files.newFile")}
          confirmLabel={t("btn.create", { ns: "common" })}
          initialPath=""
          entries={entries}
          onClose={() => setDialog(null)}
          onSubmit={create}
        />
      )}
      {dialog?.kind === "rename" && (
        <FilePathDialog
          title={t("files.newName")}
          confirmLabel={t("files.rename")}
          initialPath={dialog.path}
          // The entry being renamed is not a collision with itself.
          entries={entries.filter((entry) => entry.path !== dialog.path)}
          onClose={() => setDialog(null)}
          onSubmit={(to) => rename(dialog.path, to)}
        />
      )}
      <ConfirmModal
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        title={t("files.delete")}
        description={t("files.deleteConfirm", {
          path: dialog?.kind === "delete" ? dialog.path : "",
        })}
        confirmLabel={t("files.delete")}
        isPending={files.isPatching}
        onConfirm={() => dialog?.kind === "delete" && remove(dialog.path)}
      />
    </div>
  );
}

/**
 * The right pane for a file the author can type into: the bytes the server
 * holds, overlaid by the buffer while it is dirty.
 *
 * `onChange` is handed the server's text alongside the new one so the buffer
 * can drop an edit the author undid — see `setDraftText`.
 *
 * Monaco owns its text once it mounts (see `ContentEditor`), so every text this
 * pane must SHOW rather than receive has to arrive as a remount. What decides
 * that is the pane's baseline — the server bytes its content was composed on:
 * the buffer's `base` while one lives, the file's current server text when none
 * does. Which is exactly right in all four cases:
 *
 * - typing: `base` is pinned on the first keystroke, so the key never moves
 *   while the author works and the caret and focus stay put;
 * - another file selected: a different `entry.path`, and a different baseline;
 * - a colleague's write re-read under a live buffer: `base` is pinned, so the
 *   author's text stays on screen and the conflict banner speaks instead;
 * - *Voir la version du serveur*: dropping the buffer swings the baseline to
 *   the server text — and that button is offered only on a conflicted file,
 *   i.e. exactly when the two differ, so the remount is guaranteed.
 *
 * The baseline is tracked as a generation counter rather than used as the key
 * itself: a file is up to a mebibyte, and a key is compared on every render.
 */
function EditableFilePane({
  id,
  packageId,
  entry,
  draft,
  conflicted,
  onDiscardDraft,
  hint,
  onChange,
}: {
  id: string;
  packageId: string;
  entry: PackageFileEntry;
  draft: DraftText | undefined;
  /** The server bytes moved under this buffer — saving will write over them. */
  conflicted: boolean;
  onDiscardDraft: () => void;
  hint: string | null;
  onChange: (text: string, serverText: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { text, isLoading, isError } = usePackageFile(packageId, undefined, entry);

  // Adjusted during render rather than in an effect, so the remount happens in
  // the same commit as the baseline that calls for it — an effect would paint
  // the stale text for a frame first. React re-runs this component with the new
  // state and drops the pass below; the guard is what bounds it to one extra.
  const baseline = draft?.base ?? text;
  const [mounted, setMounted] = useState({ baseline, generation: 0 });
  if (mounted.baseline !== baseline) {
    setMounted({ baseline, generation: mounted.generation + 1 });
  }

  return (
    <div
      id={id}
      role="region"
      aria-label={entry.path}
      className="border-border bg-card flex min-w-0 flex-col rounded-lg border"
    >
      <div className="border-border flex items-center gap-3 border-b px-3 py-2">
        <span
          className="text-foreground min-w-0 flex-1 truncate font-mono text-xs"
          title={entry.path}
        >
          {entry.path}
        </span>
        {hint && <span className="text-muted-foreground shrink-0 text-xs">{hint}</span>}
      </div>
      {conflicted && (
        <div
          role="status"
          className="border-border bg-muted/50 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs"
        >
          <TriangleAlert size={14} className="shrink-0 text-amber-600" aria-hidden />
          <span className="min-w-0 flex-1">{t("files.conflictBanner")}</span>
          <Button variant="outline" size="sm" onClick={onDiscardDraft}>
            {t("files.conflictDiscard")}
          </Button>
        </div>
      )}
      {isError ? (
        <ErrorState />
      ) : isLoading || text === undefined ? (
        <LoadingState />
      ) : (
        <ContentEditor
          key={`${entry.path} ${mounted.generation}`}
          value={draft?.text ?? text}
          onChange={(next) => onChange(next, text)}
          language={languageForPath(entry.path)}
          height="520px"
        />
      )}
    </div>
  );
}

/**
 * One picked file as the standard base64 the write operation carries.
 *
 * Through `FileReader` rather than `btoa` over the bytes: a 1 MiB file is a
 * million arguments to `String.fromCharCode`, which overflows the call stack,
 * and chunking around that is a second encoder to keep correct. A data URL's
 * payload is already standard base64, the one alphabet the route accepts.
 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
