// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's field: assistant-ui's Lexical input, which keeps a skill or agent directive as an
 * atomic inline chip in the text. The library leaves the rest of what the textarea did to its host,
 * which this adds: Enter sends (or queues while a turn runs), the phone's soft-keyboard hint,
 * pasted files as attachments and the phone's no-focus-grab rule (`run-start-focus.ts`).
 */

import { useEffect, useState, type ClipboardEvent } from "react";
import { useAui } from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { useChatCommands } from "./use-chat-commands.ts";
import { ComposerDirectiveChip } from "./directive-chip.tsx";
import { COMPOSER_INPUT_CLASS } from "./phone-text.ts";
import { shouldBlurAfterRunStart } from "./run-start-focus.ts";
import { useLatest } from "./use-latest.ts";

/**
 * Plain Enter, after the `/` menu had its say: `onEnter` sends or queues. Shift+Enter is a new
 * line, and a keydown that confirms an IME composition (Safari: keyCode 229) is the IME's.
 */
function KeysPlugin({
  onEnter,
  autofocus,
}: {
  onEnter: () => void;
  /** `false` on a phone: nothing but the user's tap puts the keyboard up. */
  autofocus: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const getOnEnter = useLatest(onEnter);
  useEffect(
    () =>
      mergeRegister(
        editor.registerRootListener((root) => root?.setAttribute("enterkeyhint", "send")),
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event) => {
            if (!event || event.shiftKey || event.ctrlKey || event.metaKey) return false;
            if (event.isComposing || event.keyCode === 229) return false;
            event.preventDefault();
            getOnEnter()();
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor, getOnEnter],
  );
  // Rendered after the library's focus plugin, so its run-start listener has run when this one does.
  const aui = useAui();
  useEffect(() => {
    let focusedAtSend = false;
    const focused = () => {
      const root = editor.getRootElement();
      return !!root && root.ownerDocument.activeElement === root;
    };
    const offSend = aui.on("composer.send", () => {
      focusedAtSend = focused();
    });
    const offStart = aui.on("thread.runStart", () => {
      if (shouldBlurAfterRunStart({ autofocus, focusedAtSend, focusedNow: focused() })) {
        editor.getRootElement()?.blur();
      }
    });
    return () => {
      offSend();
      offStart();
    };
  }, [aui, editor, autofocus]);
  return null;
}

export function ComposerEditor({
  label,
  placeholder,
  autofocus,
  onFocus,
  onEnter,
}: {
  label: string;
  placeholder: string;
  autofocus: boolean;
  onFocus?: () => void;
  onEnter: () => void;
}) {
  const aui = useAui();
  // Read as soon as the field is focused (the `/` menu reads the same cache entry), so the first
  // `/` rarely waits; while it does, the popover itself holds Enter and Tab.
  const [armed, setArmed] = useState(false);
  useChatCommands(armed);
  const addPastedFiles = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!aui.thread().getState().capabilities.attachments || files.length === 0) return;
    event.preventDefault();
    for (const file of files)
      void aui
        .composer()
        .addAttachment(file)
        .catch(() => {});
  };
  return (
    <LexicalComposerInput
      aria-label={label}
      placeholder={placeholder}
      autoFocus={autofocus}
      // Enter is the plugin's: it queues while a turn runs and honours the conversation's limit.
      submitMode="none"
      directiveChip={ComposerDirectiveChip}
      onPaste={addPastedFiles}
      onFocus={() => {
        setArmed(true);
        onFocus?.();
      }}
      className={COMPOSER_INPUT_CLASS}
    >
      <KeysPlugin onEnter={onEnter} autofocus={autofocus} />
    </LexicalComposerInput>
  );
}
