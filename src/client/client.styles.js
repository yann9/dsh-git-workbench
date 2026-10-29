// dsh-git-workbench — client chunk (native DSH module chunk).
// Registered as a chunk of the plugin's client entry; see browser.js.

window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  chunk: 'client.styles.js',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React

    /* --------------------------------------------------------------- styles */

    const STYLES = `
/*
 * Theme tokens are defined for every element this plugin may render into —
 * including the ones portalled to document.body (toast, context menu, name
 * prompt, confirm + its backdrop) and the slot content rendered outside a
 * .gwb pane (the header chip menu). Layout rules stay scoped to .gwb below.
 */
.gwb, .gwb-menu, .gwb-toast, .gwb-confirm, .gwb-confirm-backdrop {
  --gwb-accent: var(--dsw-alias-state-business-primary, #3574f0);
  --gwb-accent-soft: color-mix(in srgb, var(--gwb-accent) 14%, transparent);
  --gwb-bg: var(--dsw-alias-bg-layer-1, #ffffff);
  --gwb-panel: var(--dsw-alias-bg-layer-2, var(--gwb-bg));
  --gwb-hover: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10));
  --gwb-border: var(--dsw-alias-border-l3, rgba(128,128,128,.16));
  --gwb-text: var(--dsw-alias-label-primary, #1f2328);
  --gwb-dim: var(--dsw-alias-label-secondary, #6c707e);
  /* "Faint" is still informational text here (counts, dates, paths), so it
     mixes toward --gwb-dim: the host tertiary alone is 3.7:1 at 11px. */
  --gwb-faint: color-mix(in srgb, var(--gwb-dim) 78%, var(--dsw-alias-label-tertiary, #9aa0aa));
  --gwb-add: var(--dsw-alias-file-diff-added-marker, #01a241);
  --gwb-del: var(--dsw-alias-file-diff-deleted-marker, #ba2723);
  --gwb-warn: var(--dsw-alias-state-warn-primary, #d9822b);
  --gwb-success: var(--dsw-alias-state-success-primary, #22c55e);
  --gwb-error: var(--dsw-alias-state-error-primary, #d5372f);
  /* A hue used as *text* needs an ink: the raw status colours sit at 2.3–3.4:1
     on a light panel at 11px. Mixing toward --gwb-text darkens in light mode
     and lightens in dark, so one expression serves both themes. */
  --gwb-add-ink: color-mix(in srgb, var(--gwb-add) 62%, var(--gwb-text));
  --gwb-del-ink: color-mix(in srgb, var(--gwb-del) 62%, var(--gwb-text));
  --gwb-error-ink: color-mix(in srgb, var(--gwb-error) 62%, var(--gwb-text));
  /* Text sitting on a hue-filled surface: the opposite surface colour, which is
     white in light and near-black in dark, so it never needs a per-theme rule. */
  --gwb-on-hue: var(--gwb-bg);
  --gwb-warn-ink: color-mix(in srgb, var(--gwb-warn) 66%, var(--gwb-text));
  --gwb-success-ink: color-mix(in srgb, var(--gwb-success) 56%, var(--gwb-text));
  --gwb-accent-ink: color-mix(in srgb, var(--gwb-accent) 90%, var(--gwb-text));
  --gwb-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;

  /* Diff surface — derived from the host's own design tokens (they flip with
   * the theme, so no per-theme overrides are needed here). */
  --gwb-diff-add-bg: var(--dsw-alias-file-diff-added-bg, #e6f4e7);
  --gwb-diff-add-word: color-mix(in srgb, var(--dsw-alias-file-diff-added-marker, #01a241) 26%, var(--dsw-alias-file-diff-added-bg, #e6f4e7));
  --gwb-diff-del-bg: var(--dsw-alias-file-diff-deleted-bg, #fce6e2);
  --gwb-diff-del-word: color-mix(in srgb, var(--dsw-alias-file-diff-deleted-marker, #d5372f) 24%, var(--dsw-alias-file-diff-deleted-bg, #fce6e2));
  --gwb-diff-gap: var(--dsw-alias-bg-layer-2, #f7f8fa);
  --gwb-diff-bar-add: var(--dsw-alias-file-diff-added-marker, #01a241);
  --gwb-diff-bar-del: var(--dsw-alias-file-diff-deleted-marker, #d5372f);
  /* Line numbers are text, so they owe the reader 4.5:1 — the host tertiary alone is 3.7. */
  --gwb-diff-ln: var(--gwb-dim);

  /* Syntax — the host's accent palette, not a foreign editor's. */
  --gwb-syn-keyword: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 88%, var(--dsw-alias-label-primary, #1f2328));
  --gwb-syn-string: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 62%, var(--dsw-alias-label-primary, #1f2328));
  --gwb-syn-number: var(--dsw-alias-label-primary-bluish, #0e3074);
  --gwb-syn-comment: var(--dsw-alias-label-tertiary, #81858c);
  --gwb-syn-annotation: var(--dsw-alias-state-warn-label, #dd8629);
  --gwb-syn-function: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 55%, var(--dsw-alias-label-secondary, #61666b));
}
.gwb {
  height: 100%; max-height: 100%; min-height: 0; display: flex; flex-direction: column;
  /* overflow must stay visible: hidden here would make .gwb the sticky
     containing block and the pinned header would scroll away with the page. */
  overflow: visible;
  background: var(--gwb-bg); color: var(--gwb-text);
  font-size: 12px; line-height: 1.45; min-width: 0; width: 100%;
}
.gwb *, .gwb-menu *, .gwb-toast *, .gwb-confirm *, .gwb-remotes, .gwb-remotes * { box-sizing: border-box; }
/* A reset must lose to the component classes that come after it. As a plain
   ".gwb button" rule it outranked every single-class button style and
   silently killed their colours, paddings and weights — the accent of the
   inline links, the padding of the buttons, the dim grey of the icons.
   :where() gives the rule no specificity at all, so the components win. */
:where(.gwb, .gwb-menu) button { font: inherit; color: inherit; cursor: pointer; background: none; border: 0; padding: 0; }
.gwb input, .gwb textarea { font: inherit; color: inherit; }

/* ---------------------------------------------------------------- chrome */

.gwb-head {
  display: flex; align-items: center; gap: 6px; flex: none; height: 36px; padding: 0 8px;
  border-bottom: 1px solid var(--gwb-border);
  /* Must stay visible: the branch/workspace popups are absolutely positioned
     children of this row and would be clipped to a 36px strip. */
  min-width: 0; overflow: visible;
}
.gwb-title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-repo {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 42%;
  color: var(--gwb-dim); font-size: 11px; flex: 0 1 auto; overflow: hidden;
}
.gwb-repo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.gwb-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
.gwb-foot { flex: none; border-top: 1px solid var(--gwb-border); }
.gwb-head > * { min-width: 0; flex-shrink: 1; }
.gwb-head .gwb-iconbtn, .gwb-head .gwb-btn { flex-shrink: 0; }

.gwb-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px;
  border-radius: 4px; min-width: 0; flex: 0 1 auto; overflow: hidden; color: var(--gwb-text);
}
.gwb-chip:hover { background: var(--gwb-hover); }
.gwb-chip .gwb-chip-label {
  max-width: 130px; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-weight: 500;
}
/* Meta text is also used standalone (pill row, log head, selection count). */
.gwb-chip-meta { color: var(--gwb-faint); font-size: 11px; }
/* Ahead / behind the upstream, right next to the branch name. */
.gwb-chip-deltas { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.gwb-chip-delta {
  display: inline-flex; align-items: center;
  font-size: 10.5px; font-variant-numeric: tabular-nums; line-height: 1;
  padding: 2px 3px; border-radius: 3px;
}
.gwb-chip-delta.ahead { color: var(--gwb-success-ink); background: color-mix(in srgb, var(--gwb-success) 14%, transparent); }
.gwb-chip-delta.behind { color: var(--gwb-del-ink); background: color-mix(in srgb, var(--gwb-del) 14%, transparent); }
.gwb-caret { color: var(--gwb-faint); font-size: 10px; margin-left: 1px; }
.gwb-head .gwb-caret, .gwb-group .gwb-caret, .gwb-folder .gwb-caret, .gwb-glyph .gwb-caret, .gwb-cl-head .gwb-caret { flex: none; width: 10px; text-align: center; }

.gwb-pillrow {
  display: flex; align-items: center; gap: 8px; flex: none; height: 28px; padding: 0 8px;
  border-bottom: 1px solid var(--gwb-border); background: var(--gwb-panel);
  min-width: 0; overflow: visible;
}
.gwb-pillrow .gwb-title { flex: 1 1 auto; }

/* A paused sequencer (merge/rebase/cherry-pick) is the one state where the
   panel must offer an exit, so it gets a status chip instead of a hint line. */
.gwb-opchip {
  display: inline-flex; align-items: center; gap: 6px; height: 18px; padding: 0 8px 0 7px;
  border-radius: 9px; font-size: 11px; white-space: nowrap; flex: 0 1 auto; min-width: 0;
  background: var(--gwb-accent-soft); color: var(--gwb-accent-ink);
}
.gwb-opchip::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.gwb-opchip.conflict { background: color-mix(in srgb, var(--gwb-del) 13%, transparent); color: var(--gwb-del-ink); }
.gwb-opchip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.gwb-opchip .gwb-link { color: inherit; flex: none; font-weight: 600; }
.gwb-opchip .gwb-link:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
/* Continue is pointless while conflict markers are still in the tree; say why
   through the title instead of letting git reject it with a raw message. */
.gwb-opchip .gwb-link:disabled { opacity: .45; font-weight: 500; cursor: default; }
.gwb-opchip .gwb-link:disabled:hover { background: transparent; }
.gwb-opchip .gwb-link.abort { font-weight: 500; opacity: .8; }
.gwb-opchip .gwb-link.abort:hover { opacity: 1; }

.gwb-iconbtn {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px; color: var(--gwb-dim); flex: none;
}
.gwb-iconbtn:hover { background: var(--gwb-hover); color: var(--gwb-text); }

/* Buttons must be self-contained: the confirm dialog is portalled to <body>,
   outside .gwb, where the ".gwb button" reset never applies. */
.gwb-btn {
  height: 24px; padding: 0 10px; border-radius: 4px; font-size: 12px; font-weight: 500;
  font-family: inherit; color: var(--gwb-text); background: none; border: 0; cursor: pointer;
  white-space: nowrap; flex: none;
}
.gwb-btn.sm { height: 20px; padding: 0 8px; font-size: 11px; }
.gwb-btn:hover { background: var(--gwb-hover); }
/* DSH fills its primary action with button-primary (near-black in light,
   near-white in dark); the accent hue is reserved for states and links. */
.gwb-btn.primary {
  background: var(--dsw-alias-button-primary-fill, var(--gwb-accent));
  color: var(--dsw-alias-label-primary-foreground, var(--gwb-on-hue));
}
.gwb-btn.primary:active { background: color-mix(in srgb, var(--dsw-alias-button-primary-fill, var(--gwb-accent)) 84%, #000); }
.gwb-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, color-mix(in srgb, var(--dsw-alias-button-primary-fill, var(--gwb-accent)) 88%, #000)); }
.gwb-btn.ghost { color: var(--gwb-dim); }
/* A control inside a toolbar row. The row already carries bordered icon
   groups, so a bare text button next to them reads as a caption — the border
   is what makes it clickable at a glance. */
.gwb-btn.ctl { border: 1px solid var(--gwb-border); background: var(--gwb-bg); color: var(--gwb-dim); }
.gwb-btn.ctl:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-btn.ctl.on {
  background: var(--gwb-accent-soft); color: var(--gwb-accent-ink);
  border-color: color-mix(in srgb, var(--gwb-accent) 45%, transparent);
}
.gwb-btn.ctl.on:hover { background: color-mix(in srgb, var(--gwb-accent) 20%, transparent); }
.gwb-btn.ctl:disabled { opacity: .45; cursor: default; }
.gwb-btn.on { background: color-mix(in srgb, var(--gwb-accent) 14%, transparent); color: var(--gwb-accent-ink); }
.gwb-btn.on:hover { background: color-mix(in srgb, var(--gwb-accent) 20%, transparent); }
.gwb-btn.danger { color: var(--gwb-del-ink); }
.gwb-btn.danger:hover { background: color-mix(in srgb, var(--gwb-del) 12%, transparent); }
.gwb-btn:disabled { opacity: .45; cursor: default; }
.gwb-btn:disabled:hover { background: none; }
.gwb-btn.primary:disabled:hover { background: var(--dsw-alias-button-primary-fill, var(--gwb-accent)); }

.gwb-badge { width: 12px; text-align: center; flex: none; font-size: 11px; font-weight: 600; }
.gwb-badge.m, .gwb-badge.r { color: var(--gwb-accent-ink); }
.gwb-badge.a { color: var(--gwb-add-ink); }
.gwb-badge.d { color: var(--gwb-del-ink); }
.gwb-badge.u { color: var(--gwb-warn-ink); }
.gwb-badge.c { color: var(--gwb-error-ink); }

/* ------------------------------------------------------------- file list */

.gwb-group {
  display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;
  color: var(--gwb-text); font-size: 12px; font-weight: 600; cursor: pointer;
  position: sticky; top: 0; z-index: 2; background: var(--gwb-panel);
}
.gwb-group:hover { background: var(--gwb-hover); }
.gwb-group .gwb-count { color: var(--gwb-faint); font-weight: 400; font-size: 11px; }
.gwb-group .gwb-spacer { flex: 1; }

/* Changelist: a named group of pending changes with its own commit action.
   The head pins to the top of the list; the groups inside it scroll with the
   files, so two sticky rows never fight for the same strip of pixels. */
.gwb-cl + .gwb-cl { border-top: 1px solid var(--gwb-border); }
.gwb-cl-head {
  display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px;
  color: var(--gwb-text); font-size: 12px; font-weight: 600; cursor: pointer;
  position: sticky; top: 0; z-index: 3; background: var(--gwb-panel);
}
.gwb-cl-head:hover { background: var(--gwb-hover); }
.gwb-cl-ico { display: inline-flex; color: var(--gwb-dim); }
.gwb-cl-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-cl-head .gwb-count { color: var(--gwb-faint); font-weight: 400; font-size: 11px; }
.gwb-cl-head .gwb-spacer { flex: 1; }
.gwb-cl .gwb-group {
  position: static; height: 24px; padding-left: 22px;
  font-size: 11px; font-weight: 500; color: var(--gwb-dim);
}
.gwb-cl .gwb-group .gwb-count { font-size: 10px; }
.gwb-mini { height: 20px; padding: 0 8px; border-radius: 3px; font-size: 11px; color: var(--gwb-dim); }
.gwb-mini:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-mini.on { background: var(--gwb-accent-soft); color: var(--gwb-accent-ink); }
.gwb-seg { display: inline-flex; border: 1px solid var(--gwb-border); border-radius: 4px; overflow: hidden; background: var(--gwb-bg); }
.gwb-seg .gwb-mini + .gwb-mini { border-left: 1px solid var(--gwb-border); }
.gwb-seg .gwb-mini { border-radius: 0; padding: 0 8px; height: 20px; color: var(--gwb-faint); }
/* The segment bar must still answer the pointer: this rule came after
   .gwb-mini:hover and tied on specificity, which silently killed it. */
.gwb-seg .gwb-mini:hover { color: var(--gwb-text); }
.gwb-seg .gwb-mini.on:hover { color: var(--gwb-accent-ink); }
.gwb-seg .gwb-mini.on { background: var(--gwb-accent-soft); color: var(--gwb-accent-ink); font-weight: 500; }

/* Text action inside a row header (全部暂存 / 全部取消). */
.gwb-link { height: 20px; padding: 0 4px; border-radius: 3px; color: var(--gwb-accent-ink); font-size: 11px; font-weight: 500; }
.gwb-link:hover { background: var(--gwb-accent-soft); }
/* Merge decisions and the opchip links are real <button disabled>s, and the
   only disabled styling so far was scoped to .gwb-opchip. */
.gwb-link:disabled { opacity: .5; cursor: default; }
.gwb-link:disabled:hover { background: none; }
/* The region counter in the merge toolbar is an indicator, not an action, so
   it stays neutral instead of borrowing the accent of the action links. */
.gwb-mcount {
  height: 20px; padding: 0 4px; border-radius: 3px; font-size: 11px;
  color: var(--gwb-dim); font-variant-numeric: tabular-nums;
}
.gwb-mcount:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-file { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; cursor: pointer; min-width: 0; }
.gwb-file:hover { background: var(--gwb-hover); }
.gwb-file.active { background: var(--gwb-accent-soft); box-shadow: inset 2px 0 0 var(--gwb-accent); }
.gwb-file .gwb-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.gwb-file .gwb-path .gwb-dir { color: var(--gwb-faint); margin-left: 6px; }
.gwb-file .gwb-name { font-weight: 500; }
.gwb-path .gwb-from { color: var(--gwb-faint); font-size: 11px; margin-left: 6px; font-weight: 400; }
.gwb-file .gwb-dir { color: var(--gwb-faint); font-size: 11px; }
.gwb-file .gwb-stats { color: var(--gwb-faint); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
.gwb-file .gwb-open { color: var(--gwb-faint); flex: none; margin-left: 10px; opacity: .7; }
/* Per-file actions stay out of the way until the row is hovered — the list is
   read by name, and a permanent icon column would cost width on every row. */
.gwb-file .gwb-rowacts { display: none; flex: none; align-items: center; gap: 1px; margin-left: 6px; }
.gwb-file:hover .gwb-rowacts, .gwb-file.active .gwb-rowacts { display: inline-flex; }
/* Tabbing into a row action reveals it the same way a hover does. */
.gwb-file:focus-within .gwb-rowacts { display: inline-flex; }
.gwb-file .gwb-rowacts .gwb-iconbtn { width: 20px; height: 20px; border: 1px solid var(--gwb-border); border-radius: 4px; background: var(--gwb-bg); }
.gwb-file .gwb-rowacts .gwb-iconbtn:hover { border-color: var(--gwb-accent); color: var(--gwb-accent-ink); background: var(--gwb-hover); }
.gwb-iconbtn.danger:hover, .gwb-file .gwb-rowacts .gwb-iconbtn.danger:hover { color: var(--gwb-del-ink); border-color: color-mix(in srgb, var(--gwb-del) 55%, transparent); background: color-mix(in srgb, var(--gwb-del) 10%, transparent); }
.gwb-iconbtn.success:hover, .gwb-file .gwb-rowacts .gwb-iconbtn.success:hover { color: var(--gwb-add-ink); border-color: color-mix(in srgb, var(--gwb-add) 55%, transparent); background: color-mix(in srgb, var(--gwb-add) 10%, transparent); }
.gwb-file input[type="checkbox"], .gwb-check input[type="checkbox"] {
  appearance: none; -webkit-appearance: none; width: 13px; height: 13px; margin: 0; flex: none;
  border: 1.5px solid color-mix(in srgb, var(--gwb-dim) 55%, transparent); border-radius: 3px;
  background: var(--gwb-bg); display: inline-grid; place-content: center; cursor: pointer; position: relative;
}
.gwb-file input[type="checkbox"]:hover, .gwb-ca .gwb-check input:hover { border-color: var(--gwb-accent); }
/* The visual box stays 13px; the pseudo-element is what the pointer hits. */
.gwb-file input[type="checkbox"]::before, .gwb-check input[type="checkbox"]::before {
  content: ''; position: absolute; inset: -5px -4px;
}
.gwb-file input[type="checkbox"]:checked, .gwb-ca .gwb-check input:checked { background: var(--gwb-accent); border-color: var(--gwb-accent); }
.gwb-file input[type="checkbox"]:checked::after, .gwb-ca .gwb-check input:checked::after {
  content: ''; width: 7px; height: 3.5px; border-left: 1.5px solid #fff; border-bottom: 1.5px solid #fff;
  transform: rotate(-45deg) translateY(-1px);
}
.gwb-folder { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; cursor: pointer; color: var(--gwb-dim); font-size: 12px; font-weight: 500; min-width: 0; }
.gwb-folder:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-folder .gwb-grow { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-folder .gwb-count { color: var(--gwb-faint); font-size: 11px; flex: none; }
/* Icon slot of a folder row (caret + folder glyph); files put the bare badge
   straight into the row so both indent identically. */
.gwb-glyph { width: 26px; flex: none; display: inline-flex; align-items: center; gap: 3px; }

.gwb-loading { padding: 14px 10px; color: var(--gwb-faint); }
.gwb-body-empty { height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
.gwb-body-empty .gwb-loading { padding: 0; }
.gwb-empty-state {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  max-width: 260px; text-align: center; color: var(--gwb-faint); line-height: 1.6;
}
.gwb-empty-state .gwb-empty-icon {
  width: 36px; height: 36px; border-radius: 50%; display: inline-flex;
  align-items: center; justify-content: center;
  background: var(--gwb-hover); color: var(--gwb-dim); font-size: 16px;
}
/* The faint utility class is used by the diff line markers; without a rule of
   its own it silently inherited body colour. */
.gwb-faint { color: var(--gwb-faint); font-size: 11px; }
.gwb-empty { margin: 18px 12px; padding: 22px 16px; border: 1px dashed var(--gwb-border); border-radius: 6px; color: var(--gwb-dim); text-align: center; line-height: 1.6; }
.gwb-empty-hint { font-size: 11px; color: var(--gwb-faint); word-break: break-all; }
.gwb-empty-state .gwb-empty-hint + .gwb-empty-hint { word-break: normal; margin-top: 2px; }
.gwb-empty-state .gwb-btn { margin-top: 2px; }
.gwb-empty-error {
  max-width: 100%; padding: 6px 8px; border-radius: 5px; text-align: left;
  font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  color: var(--gwb-error-ink);
  background: color-mix(in srgb, var(--gwb-error) 9%, transparent);
}

/* A folder with no repository has nothing to branch, stage or commit, so the
   status pill and the commit box are removed rather than shown and disabled —
   a greyed-out 提交 still asks the user to work out why it is grey. */
.gwb[data-norepo="1"] .gwb-pillrow,
.gwb[data-norepo="1"] .gwb-commitbar { display: none; }

/* ------------------------------------------------------- history filters */
/* Scoped to the history tab: the log search row already owns .gwb-filter. */
.gwb-filterbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--gwb-border); background: var(--gwb-panel); }
.gwb-fchip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0;
  padding: 3px 8px; border-radius: 999px; background: var(--gwb-accent-soft); color: var(--gwb-accent-ink); font-size: 11px;
}
.gwb-fchip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-fchip-x {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: inherit; cursor: pointer; opacity: .7;
}
.gwb-fchip-x:hover { opacity: 1; background: var(--gwb-hover); }
.gwb-error { margin: 10px; padding: 8px 10px; border-radius: 4px; background: color-mix(in srgb, var(--gwb-del) 10%, transparent); color: var(--gwb-del-ink); white-space: pre-wrap; }
.gwb-error .gwb-btn { display: block; margin-top: 8px; white-space: normal; }

/* ------------------------------------------------------------ commit bar */

.gwb-commitbar { display: flex; flex-direction: column; gap: 8px; padding: 8px; min-width: 0; }
.gwb-commitbar textarea { flex: 1 1 auto; min-width: 0; min-height: 68px; max-height: 160px; resize: vertical; padding: 8px 10px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3, var(--gwb-bg)); font-family: var(--gwb-mono); font-size: 12px; line-height: 1.5; outline: none; }
.gwb-commitbar textarea::placeholder { color: var(--gwb-faint); font-size: 11px; }
.gwb-commitbar textarea:focus { border-color: var(--gwb-accent); }
.gwb-commitbar .gwb-ca { display: flex; flex-direction: column; align-items: stretch; gap: 6px; min-width: 0; }
.gwb-commitbar .gwb-ca-row { display: flex; align-items: center; gap: 8px; }
.gwb-commitbar .gwb-ca-row:last-child { justify-content: space-between; }
.gwb-commit-actions { display: inline-flex; align-items: stretch; gap: 0; flex: none; }
.gwb-commitbar .gwb-btn.primary { min-width: 72px; justify-content: center; height: 28px; display: inline-flex; align-items: center; }
.gwb-commit-actions .gwb-btn.primary:first-child {
  border-top-right-radius: 0; border-bottom-right-radius: 0;
}
/* Higher specificity than the 72px primary min-width: the caret is a narrow
   appendage, not a second full-width button. */
.gwb-commitbar .gwb-commit-actions .gwb-btn.gwb-split-caret {
  min-width: 24px; width: 24px; padding: 0; height: 28px;
  border-top-left-radius: 0; border-bottom-left-radius: 0;
  border-left: 1px solid color-mix(in srgb, currentColor 32%, transparent);
}
/* A disabled primary must read as disabled instead of a washed-out blue. */
.gwb-commitbar .gwb-btn.primary:disabled { background: var(--gwb-hover); color: var(--gwb-faint); opacity: 1; }
.gwb-commitbar .gwb-hint { padding: 0; flex: 1; text-align: left; color: var(--gwb-faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-ca .gwb-check { display: inline-flex; align-items: center; gap: 5px; color: var(--gwb-dim); font-size: 11px; user-select: none; flex: none; }
.gwb-ca .gwb-check input { accent-color: var(--gwb-accent); margin: 0; }
.gwb-counter { margin-left: auto; color: var(--gwb-faint); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
.gwb-counter.warn { color: var(--gwb-warn-ink); }
.gwb-counter.over { color: var(--gwb-del-ink); }

/* ------------------------------------------------------- pre-commit checks */

.gwb-checkmenu { flex: none; }
.gwb-checkbtn { display: inline-flex; align-items: center; gap: 5px; flex: none; white-space: nowrap; }
.gwb-checkbtn > span:not(.gwb-check-dot) { overflow: hidden; text-overflow: ellipsis; }
.gwb-checkbtn.running { color: var(--gwb-accent-ink); }
.gwb-checkbtn.fail { color: var(--gwb-del-ink); }
.gwb-check-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.gwb-check-dot.pass { background: var(--gwb-add); }
.gwb-check-dot.fail { background: var(--gwb-del); }
.gwb-menu .gwb-menu-hint {
  padding: 4px 12px 5px; color: var(--gwb-faint); font-size: 10.5px; line-height: 1.45;
  white-space: normal;
}
.gwb-menu .gwb-menu-hint.quiet { padding-top: 3px; }
.gwb-menu .gwb-menu-check {
  display: flex; align-items: flex-start; gap: 9px; padding: 5px 12px;
  border-radius: 5px; cursor: pointer; min-width: 0;
}
.gwb-menu .gwb-menu-check:hover { background: var(--gwb-hover); }
/* The host styles bare inputs with a width that fits a form field, so the
   menu checkbox needs the same explicit box the file rows use. */
.gwb-menu .gwb-menu-check input[type="checkbox"] {
  appearance: none; -webkit-appearance: none; width: 13px; height: 13px; min-width: 13px;
  margin: 2px 0 0; flex: 0 0 13px; padding: 0; cursor: pointer; position: relative;
  border: 1.5px solid color-mix(in srgb, var(--gwb-dim) 55%, transparent); border-radius: 3px;
  background: var(--gwb-bg); display: inline-grid; place-content: center;
}
.gwb-menu .gwb-menu-check input[type="checkbox"]:hover { border-color: var(--gwb-accent); }
.gwb-menu .gwb-menu-check input[type="checkbox"]:checked { background: var(--gwb-accent); border-color: var(--gwb-accent); }
.gwb-menu .gwb-menu-check input[type="checkbox"]:checked::after {
  content: ''; width: 7px; height: 3.5px; border-left: 1.5px solid #fff; border-bottom: 1.5px solid #fff;
  transform: rotate(-45deg) translateY(-1px);
}
.gwb-menu-checktext { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.gwb-menu-checkname { display: flex; align-items: center; gap: 7px; min-width: 0; }
.gwb-menu-checklabel { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-menu-checkcmd {
  font-family: var(--gwb-mono); font-size: 10px; color: var(--gwb-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gwb-check-result { margin-left: auto; font-size: 10.5px; font-variant-numeric: tabular-nums; flex: none; }
.gwb-check-result.pass { color: var(--gwb-add-ink); }
.gwb-check-result.fail { color: var(--gwb-del-ink); }
.gwb-menu-ico { width: 16px; display: inline-flex; justify-content: center; color: var(--gwb-dim); flex: none; }

/* The failure dialog trades the narrow confirm card for a scrollable console. */
/* Two classes: this block sits above .gwb-confirm, whose 420px card must not
   win the cascade for the console-sized failure dialog. */
.gwb-confirm.gwb-check-dialog {
  width: min(680px, 92vw); max-width: min(680px, 92vw); max-height: min(82vh, 640px);
  display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; overflow: hidden;
}
.gwb-check-head { display: flex; align-items: flex-start; gap: 10px; }
.gwb-check-ico {
  width: 22px; height: 22px; border-radius: 50%; flex: none; margin-top: 1px;
  display: grid; place-items: center;
  color: var(--gwb-del-ink); background: color-mix(in srgb, var(--gwb-del) 13%, transparent);
}
.gwb-check-headtext { flex: 1 1 auto; min-width: 0; }
.gwb-check-title { font-size: 13px; font-weight: 600; line-height: 1.35; }
.gwb-check-meta {
  margin-top: 2px; color: var(--gwb-faint); font-size: 11px;
  font-family: var(--gwb-mono); overflow-wrap: anywhere;
}
.gwb-check-copy { flex: none; }
.gwb-check-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.gwb-check-chip {
  display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px;
  font-size: 10.5px; font-family: var(--gwb-mono); color: var(--gwb-dim);
  background: var(--gwb-hover);
}
.gwb-check-chip.pass { color: var(--gwb-add-ink); background: color-mix(in srgb, var(--gwb-add) 12%, transparent); }
.gwb-check-chip.fail { color: var(--gwb-del-ink); background: color-mix(in srgb, var(--gwb-del) 12%, transparent); }
.gwb-check-output {
  flex: 1 1 auto; min-height: 64px; max-height: min(46vh, 360px); overflow: auto;
  margin: 0; padding: 10px 12px; border: 1px solid var(--gwb-border); border-radius: 6px;
  background: var(--gwb-diff-gap); color: var(--gwb-text);
  font-family: var(--gwb-mono); font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.gwb-check-output:focus-visible { outline: 2px solid var(--gwb-accent); outline-offset: -2px; }

/* --------------------------------------------------------------- log pane */

.gwb-log-split { display: flex; flex: 1 1 auto; min-height: 0; }
.gwb-log-list { flex: 0 0 46%; min-width: 190px; border-right: 1px solid var(--gwb-border); display: flex; flex-direction: column; }
.gwb-log-detail { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 10px 12px; }
.gwb-logrow { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; cursor: pointer; white-space: nowrap; }
.gwb-logrow:hover { background: var(--gwb-hover); }
/* Selected rows carry the tint; the row whose details are open carries the
   bar. One click sets both, so the common case shows both marks. */
.gwb-logrow.sel { background: var(--gwb-accent-soft); }
.gwb-logrow.sel:hover { background: color-mix(in srgb, var(--gwb-accent) 22%, transparent); }
.gwb-logrow.active { box-shadow: inset 2px 0 0 var(--gwb-accent); }
/* The selection bar replaces the log's own header row: a count chip on the
   left, the commit actions and the view controls on the right. */
.gwb-selbar {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px; flex: none;
  border-bottom: 1px solid var(--gwb-border);
  background: color-mix(in srgb, var(--gwb-accent) 6%, var(--gwb-panel));
  /* A narrow column wraps the controls onto a second line instead of clipping
     them — the count chip and the toggle both ellipsize first. */
  flex-wrap: wrap; row-gap: 4px;
}
.gwb-selbar-count {
  flex: none; min-width: 0; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 16px; color: var(--gwb-accent-ink); white-space: nowrap;
  background: color-mix(in srgb, var(--gwb-accent) 13%, transparent);
}
/* The four commit actions read as one button group — the IDEA toolbar groups
   its icons the same way; bare glyphs on a tinted strip look like leftovers. */
.gwb-selbar-group {
  display: inline-flex; align-items: stretch; gap: 1px; flex: none; margin-left: auto;
  padding: 1px; border: 1px solid var(--gwb-border); border-radius: 6px; background: var(--gwb-bg);
}
.gwb-selbar-group .gwb-selbtn { width: 22px; height: 20px; border-radius: 4px; }
.gwb-selbar-group .gwb-selbtn:hover { color: var(--gwb-accent-ink); }
/* The view filter and the clear button form the second group: the filter is a
   toggle, the clear closes it, so they belong together. */
.gwb-selbar-view { margin-left: 0; }
.gwb-seltoggle {
  flex: 0 1 auto; min-width: 0; height: 20px; padding: 0 9px; border-radius: 4px;
  font-size: 11px; line-height: 16px; color: var(--gwb-dim); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.gwb-seltoggle:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-seltoggle.on {
  font-weight: 500; color: var(--gwb-accent-ink);
  background: var(--gwb-accent-soft);
}
.gwb-selclear {
  flex: none; width: 22px; height: 20px; padding: 0; border-radius: 4px;
  border-left: 1px solid var(--gwb-border);
  display: inline-flex; align-items: center; justify-content: center; color: var(--gwb-faint);
}
.gwb-selclear:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-logrow .gwb-subject { display: flex; align-items: center; gap: 5px; font-size: 12px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
/* The labels name the branch, so they keep their width and the message is
   what gives way: "origin/m…" still says "a remote branch", "or…" says
   nothing at all. The row decides how many labels it can spell out in full
   and folds the rest into a "+N" chip, so nothing is ever cut in half. */
.gwb-logrow .gwb-refs { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; max-width: 100%; }
.gwb-logrow .gwb-subject-text { flex: 1 1 auto; min-width: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-log-graph { width: var(--gwb-col-graph, 56px); flex: none; overflow: hidden; }
.gwb-logrow .gwb-author { color: var(--gwb-faint); font-size: 11px; flex: 0 0 var(--gwb-col-author, 92px); overflow: hidden; text-overflow: ellipsis; }
.gwb-logrow .gwb-date { color: var(--gwb-faint); font-size: 11px; flex: 0 0 var(--gwb-col-date, 76px); font-variant-numeric: tabular-nums; }
.gwb-logrow .gwb-hash { color: var(--gwb-faint); font-size: 10px; flex: 0 0 var(--gwb-col-hash, 66px); overflow: hidden; text-overflow: ellipsis; font-family: var(--gwb-mono, monospace); }
/* The table header: it sorts the log the way the IDE's log does, so the labels
   have to sit exactly over the cells they name. */
.gwb-logcols {
  display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 8px; flex: none;
  font-size: 10px; color: var(--gwb-faint); background: var(--gwb-panel);
  border-bottom: 1px solid var(--gwb-border); user-select: none;
}
/* The header cell is the column, not a button: the sort control and the
   drag edge are two siblings inside it, so both can take the keyboard. */
.gwb-logcols-cell {
  display: flex; align-items: center; gap: 4px; height: 100%; padding: 0;
  color: inherit; cursor: pointer; min-width: 0;
  /* The cell clips nothing itself: the label ellipsises, and the drag edge
     has to reach past the cell into the gap. */
  overflow: visible; white-space: nowrap;
  /* The column edge is drawn, not implied: a hairline that says where one
     column ends and the next begins. The drag grip paints over it. */
  background-image: linear-gradient(var(--gwb-col-sep, color-mix(in srgb, var(--gwb-text) 18%, transparent)), var(--gwb-col-sep, color-mix(in srgb, var(--gwb-text) 18%, transparent)));
  background-repeat: no-repeat; background-position: right center; background-size: 1px 14px;
}
.gwb-logcols-sort {
  display: flex; align-items: center; gap: 4px; min-width: 0; height: 100%;
  flex: 1 1 auto; padding: 0; background: none; border: 0; font: inherit; color: inherit; cursor: pointer;
  overflow: hidden;
}
.gwb-logcols-cell:hover { color: var(--gwb-text); }
.gwb-logcols-cell.on { color: var(--gwb-text); font-weight: 600; }
.gwb-logcols-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gwb-logcols-arrow { font-size: 8px; line-height: 1; flex: none; }
.gwb-logcols .gwb-subject { flex: 1 1 auto; min-width: 0; }
/* Once the message column has a width of its own it keeps it: the row ends
   where the columns end, and the free space waits on the right. */
.gwb-log-list[data-custom-subject="1"] .gwb-logrow .gwb-subject,
.gwb-log-list[data-custom-subject="1"] .gwb-logcols .gwb-subject { flex: 0 1 var(--gwb-col-subject); }
.gwb-log-list[data-custom-subject="1"] .gwb-logrow .gwb-rowmore,
.gwb-log-list[data-custom-subject="1"] .gwb-logcols-more { margin-left: auto; }
/* Matches the row's trailing commit-menu button, margins included. */
.gwb-logcols-more { flex: none; width: 20px; margin-left: -2px; margin-right: -4px; }
.gwb-logcols .gwb-author { flex: 0 0 var(--gwb-col-author, 92px); }
.gwb-logcols .gwb-date { flex: 0 0 var(--gwb-col-date, 76px); }
.gwb-logcols .gwb-hash { flex: 0 0 var(--gwb-col-hash, 66px); }
/* Every header cell owns a drag edge: the graph clips at its default width
   once the history has more lanes, and a long author deserves the room the
   user gives it. The edge sits in the gap between two cells. */
.gwb-logcols-cell, .gwb-logcols .gwb-log-graph { position: relative; }
/* The graph header cell has no glyph of its own to give it height, so it
   stretches instead: a zero-height cell would leave the drag edge unhittable. */
.gwb-logcols .gwb-log-graph { overflow: visible; align-self: stretch; cursor: default; }
.gwb-colresize { position: absolute; top: 0; bottom: 0; right: -4px; width: 8px; cursor: col-resize; z-index: 2; }
/* The grip paints its own line over the column hairline, so the place to
   take hold of says so the moment the pointer lands on it. */
.gwb-colresize::after { content: ''; position: absolute; top: 4px; bottom: 4px; left: 3px; width: 1px; background: transparent; }
.gwb-colresize:hover::after, .gwb-colresize.on::after {
  background: var(--gwb-accent); width: 2px; left: 2.5px;
}
/* The graph only exists in the history order, so losing it looks like a bug.
   This chip says what happened and puts the history order back in one click. */
.gwb-graphhint {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
  height: 22px; padding: 0 8px; border: 0; border-radius: 4px;
  background: var(--gwb-accent-soft); color: var(--gwb-accent-ink);
  font: inherit; font-size: 11px; white-space: nowrap; cursor: pointer;
}
.gwb-graphhint:hover { background: var(--gwb-accent); color: var(--gwb-on-hue); }
.gwb-ref { padding: 0 5px; height: 18px; line-height: 18px; border-radius: 3px; background: var(--gwb-accent-soft); color: var(--gwb-accent-ink); font-size: 11px; font-weight: 500; flex: 0 0 auto; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-ref.head { background: var(--gwb-accent); color: var(--gwb-on-hue); }
/* The "+N" chip stands for the labels that did not fit — it says how many,
   and its tooltip names them. */
.gwb-ref.gwb-ref-more { background: transparent; border: 1px solid var(--gwb-border); color: var(--gwb-faint); font-weight: 400; }
/* The header of a grouped log: a foldable section, so it reads like the
   section rows of the changelist tree and not like another commit. */
.gwb-loggroup {
  display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;
  font-size: 11px; font-weight: 600; color: var(--gwb-dim); cursor: pointer;
  background: var(--gwb-panel); border-bottom: 1px solid var(--gwb-border);
  min-width: 0; overflow: hidden;
}
.gwb-loggroup:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-loggroup .gwb-caret { flex: none; width: 10px; text-align: center; }
.gwb-loggroup .gwb-rowicon { color: var(--gwb-faint); flex: none; }
.gwb-loggroup:hover .gwb-rowicon { color: var(--gwb-dim); }
.gwb-loggroup-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-loggroup .gwb-count { flex: none; color: var(--gwb-faint); font-weight: 400; font-variant-numeric: tabular-nums; }
/* A folded group keeps its header but drops its tint: the list below it
   belongs to another group now. */
.gwb-loggroup.collapsed { color: var(--gwb-faint); }
.gwb-filter { display: flex; align-items: center; gap: 6px; padding: 6px 8px 4px; flex: none; }
/* The search field owns its border so the magnifier and the field picker can
   live inside it; the bare input drops the chrome it would otherwise draw. */
.gwb-search {
  display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0;
  height: 24px; padding: 0 4px 0 8px; border: 1px solid var(--gwb-border);
  border-radius: 4px; background: var(--gwb-bg);
}
.gwb-search:focus-within { border-color: var(--gwb-accent); }
.gwb-search-icon { display: inline-flex; align-items: center; flex: none; color: var(--gwb-faint); }
.gwb-search input {
  flex: 1 1 auto; min-width: 0; height: 100%; padding: 0; border: 0; border-radius: 0;
  background: transparent; outline: none; color: inherit;
}
/* The browser's own clear button is a loud blue ✕ that sits right next to the
   field picker and reads as a second trailing control. The chips below the
   field already remove the conditions one by one, so it only adds noise. */
.gwb-search input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
.gwb-search-caret {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 18px; height: 18px; padding: 0; border: 0; border-radius: 3px;
  background: transparent; color: var(--gwb-faint); cursor: pointer;
}
.gwb-search-caret:hover { background: var(--gwb-hover); color: var(--gwb-text); }
/* The parsed conditions of the search. A condition wears the pill of the
   other history filters; free text stays neutral — it is words, not a field —
   and a field without a value yet is outlined rather than filled. */
.gwb-qchips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 0 8px 6px; }
/* A chip keeps its width and lets the row wrap: squeezed chips turn every
   value into an ellipsis, and a condition nobody can read is no condition. */
.gwb-qchip { flex: 0 0 auto; max-width: min(240px, 100%); }
.gwb-qchip-key { font-family: var(--gwb-mono); font-weight: 600; }
.gwb-qchip.free { background: var(--gwb-hover); color: var(--gwb-dim); }
.gwb-qchip.pending { background: transparent; color: var(--gwb-faint); box-shadow: inset 0 0 0 1px var(--gwb-border); }
.gwb-commitmeta h3 { margin: 0 0 4px; font-size: 13px; }
.gwb-commithead { display: flex; align-items: center; gap: 4px; }
.gwb-commithead h3 { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-commitmeta .gwb-meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--gwb-faint); font-size: 11px; }
.gwb-hash { font-family: var(--gwb-mono); cursor: pointer; }
.gwb-hash:hover { color: var(--gwb-accent-ink); text-decoration: underline; }
.gwb-commitmeta pre { margin: 6px 0 0; white-space: pre-wrap; font-family: var(--gwb-mono); font-size: 12px; color: var(--gwb-dim); }
.gwb-hint { padding: 4px 0 8px; color: var(--gwb-faint); font-size: 11px; }
.gwb-filesbar { display: flex; align-items: center; gap: 8px; padding: 4px 0 6px; }
.gwb-filesbar .gwb-title { color: var(--gwb-faint); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }

/* ------------------------------------------------------------- diff view */

.gwb-diffhead { display: flex; align-items: center; gap: 8px; flex: none; height: 34px; padding: 0 8px; border-bottom: 1px solid var(--gwb-border); position: sticky; top: 0; z-index: 6; background: var(--gwb-bg); }
.gwb-diffname { flex: 0 1 auto; min-width: 72px; display: flex; align-items: baseline; overflow: hidden; white-space: nowrap; font-family: var(--gwb-mono); font-size: 12px; }
.gwb-crumb-dir { color: var(--gwb-faint); }
.gwb-crumb-sep { color: var(--gwb-faint); margin: 0 2px; }
.gwb-crumb-name { color: var(--gwb-text); font-weight: 500; }
.gwb-sha { flex: none; padding: 0 6px; height: 20px; line-height: 20px; border-radius: 4px; background: var(--gwb-panel); border: 1px solid var(--gwb-border); color: var(--gwb-faint); font-family: var(--gwb-mono); font-size: 11px; }
.gwb-diffhead .gwb-actions { flex: none; margin-left: auto; display: flex; align-items: center; gap: 4px; }
.gwb-diffhead .gwb-chip-meta { font-variant-numeric: tabular-nums; }
.gwb-readonly { padding: 1px 7px; border-radius: 4px; background: var(--gwb-hover); color: var(--gwb-faint); font-size: 11px; white-space: nowrap; }

.gwb-difftoolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px; flex: none; min-height: 30px; border-bottom: 1px solid var(--gwb-border); position: sticky; top: 34px; z-index: 6; background: var(--gwb-bg); }
/* Change navigation and the file switcher read as one control strip: same
   26px outer height, same border treatment. */
.gwb-hunknav { display: inline-flex; align-items: center; gap: 1px; border: 1px solid var(--gwb-border); border-radius: 6px; padding: 1px 2px; flex: none; }
.gwb-hunknav .gwb-iconbtn { width: 22px; height: 22px; font-size: 12px; }
.gwb-hunknav .gwb-label { font-size: 10.5px; color: var(--gwb-faint); padding: 0 3px; }
.gwb-diffnav {
  /* Two identical pills touching each other read as one control. */
  display: inline-flex; align-items: center; gap: 1px; margin-left: 10px;
  border: 1px solid var(--gwb-border); border-radius: 6px; padding: 1px 2px; flex: none;
}
.gwb-diffnav .gwb-iconbtn { width: 24px; height: 22px; font-size: 14px; }
.gwb-navcount {
  min-width: 58px; height: 22px; line-height: 22px; text-align: center; font-size: 11px;
  color: var(--gwb-text); font-variant-numeric: tabular-nums; border-radius: 4px; padding: 0 4px;
}
.gwb-navcount:hover { background: var(--gwb-hover); color: var(--gwb-text); }
.gwb-diffstats {
  display: inline-flex; align-items: center; gap: 5px; flex: none; margin-left: 4px;
  font-size: 11px; color: var(--gwb-dim); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.gwb-diffstats .gwb-plus { color: var(--gwb-add-ink); font-weight: 500; }
.gwb-diffstats .gwb-minus { color: var(--gwb-del-ink); font-weight: 500; }
.gwb-diffstats .gwb-diffstats-sep { color: var(--gwb-faint); margin: 0 1px; }
.gwb-diffstats .gwb-label { font-variant-numeric: tabular-nums; }

.gwb-diffbody { flex: 1 1 auto; min-height: 0; overflow: auto; font-family: var(--dsw-font-markdown-code-font-family, var(--gwb-mono)); font-size: 12px; line-height: 20px; }
.gwb-section { margin: 0; padding: 4px 10px; font-size: 11px; font-weight: 600; color: var(--gwb-dim); border-bottom: 1px solid var(--gwb-border); position: sticky; top: 0; background: var(--gwb-panel); z-index: 4; }
/* Only a split diff has a sticky version-label row above the section title. */
.gwb[data-view="split"] .gwb-section { top: 18px; }
/* The monospace face belongs to the code in the header, not to the action
   that sits next to it: a control in the code font reads as part of the
   diff, so the font moves to the spans that actually carry code. */
.gwb-hunkhead { scroll-margin-top: 72px; display: flex; align-items: center; gap: 8px; padding: 1px 10px; background: var(--gwb-panel); border-top: 1px solid var(--gwb-border); border-bottom: 1px solid var(--gwb-border); color: var(--gwb-faint); font-size: 11px; }
.gwb-hunkmark { color: var(--gwb-faint); letter-spacing: -2px; font-family: var(--gwb-mono); }
.gwb-hunkrange { color: var(--gwb-dim); font-family: var(--gwb-mono); }
.gwb-hunksection { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gwb-faint); font-family: var(--gwb-mono); }
.gwb-hunkhead .gwb-hunkbtn { margin-left: auto; flex: none; }
.gwb-hunkhead.gwb-flash { animation: gwb-flash .8s ease-out; }
@keyframes gwb-flash { 0% { background: var(--gwb-accent-soft); } 100% { background: var(--gwb-panel); } }
.gwb-hunkgap { display: flex; align-items: center; gap: 6px; padding: 1px 12px; color: var(--gwb-faint); font-size: 10.5px; background: var(--gwb-bg); border-top: 1px dashed var(--gwb-border); border-bottom: 1px dashed var(--gwb-border); }
/* Collapsed unchanged run inside a whole-file diff (click to expand). */
.gwb-foldrow { background: var(--gwb-bg); border-top: 1px dashed var(--gwb-border); border-bottom: 1px dashed var(--gwb-border); }
.gwb-foldspan { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; padding: 1px 12px; color: var(--gwb-faint); font-size: 10.5px; cursor: pointer; user-select: none; }
.gwb-foldspan:hover { color: var(--gwb-text); background: var(--gwb-hover); }

/* Side-by-side version labels, aligned to the row grid below them. */
.gwb-diffside { display: grid; grid-template-columns: 46px 12px minmax(0,1fr) 18px 46px 12px minmax(0,1fr); align-items: center; height: 18px; background: var(--gwb-panel); border-bottom: 1px solid var(--gwb-border); position: sticky; top: 0; z-index: 5; }
.gwb-diffside span { padding: 0 10px; font-size: 10.5px; color: var(--gwb-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The bridge cell must carry the same verticals as the .gwb-dc.con rows below. */
.gwb-diffside .gwb-diffside-con { border-left: 1px solid var(--gwb-border); border-right: 1px solid var(--gwb-border); }
.gwb-diffside .gwb-diffside-right { border-left: 1px solid var(--gwb-border); }

.gwb-drow { display: grid; align-items: stretch; min-width: 0; scroll-margin-top: 72px; }
.gwb-drow[data-mode="side"] { grid-template-columns: 46px 12px minmax(0,1fr) 18px 46px 12px minmax(0,1fr); }
.gwb-drow[data-mode="unified"] { grid-template-columns: 46px 46px 12px minmax(0,1fr); }
.gwb-dc { min-height: 20px; line-height: 20px; min-width: 0; overflow: hidden; }
/* IDEA keeps line numbers neutral; the coloured change bar carries the state. */
.gwb-dc.ln { text-align: right; padding-right: 8px; color: var(--gwb-diff-ln); font-size: 11px; user-select: none; background: var(--gwb-panel); border-right: 1px solid var(--gwb-border); font-variant-numeric: tabular-nums; }
.gwb-dc.ln.pad { background: var(--gwb-diff-gap); }
.gwb-dc.bar { position: relative; background: transparent; user-select: none; }
.gwb-dc.bar.add { cursor: pointer; background: linear-gradient(to right, var(--gwb-diff-bar-add) 3px, transparent 3px); }
.gwb-dc.bar.del { cursor: pointer; background: linear-gradient(to right, var(--gwb-diff-bar-del) 3px, transparent 3px); }
/* Hover/selection must repaint the gradient itself — a background-color under
   a background-image is invisible. */
.gwb-dc.bar.add:hover { background: linear-gradient(to right, var(--gwb-diff-bar-add) 3px, var(--gwb-hover) 3px); }
.gwb-dc.bar.del:hover { background: linear-gradient(to right, var(--gwb-diff-bar-del) 3px, var(--gwb-hover) 3px); }
.gwb-dc.bar.pad { background: var(--gwb-diff-gap); }
.gwb-dc.code { padding: 0 10px; white-space: pre-wrap; overflow-wrap: break-word; }
/* diffWrap: false — clip instead of wrapping (horizontal scroll stays available) */
.gwb-nowrap .gwb-dc.code { white-space: pre; overflow-wrap: normal; }
.gwb-dc.code.add { background: var(--gwb-diff-add-bg); }
.gwb-dc.code.del { background: var(--gwb-diff-del-bg); }
.gwb-dc.code.pad { background-color: var(--gwb-diff-gap); background-image: repeating-linear-gradient(135deg, transparent 0 6px, rgba(128,128,128,.06) 6px 7px); }

/* The connector between the two panes: the visual "link" of a change pair. */
.gwb-dc.con { background: var(--gwb-bg); border-left: 1px solid var(--gwb-border); border-right: 1px solid var(--gwb-border); }
.gwb-dc.con.add { background: var(--gwb-diff-add-bg); }
.gwb-dc.con.del { background: var(--gwb-diff-del-bg); }
.gwb-dc.con.mod { background: linear-gradient(to right, var(--gwb-diff-del-bg), var(--gwb-diff-add-bg)); }
.gwb-dc.con.pad { background: var(--gwb-diff-gap); }
/* Hovering a row lights the pair on both sides and the bridge between them. */
.gwb-drow:hover .gwb-dc.code.add { background: color-mix(in srgb, var(--gwb-diff-add-word) 58%, var(--gwb-diff-add-bg)); }
.gwb-drow:hover .gwb-dc.code.del { background: color-mix(in srgb, var(--gwb-diff-del-word) 58%, var(--gwb-diff-del-bg)); }
.gwb-drow:hover .gwb-dc.con.add, .gwb-drow:hover .gwb-dc.con.del, .gwb-drow:hover .gwb-dc.con.mod { filter: saturate(1.3); }
.gwb-drow:hover .gwb-dc.ln { color: var(--gwb-text); }
.gwb-dc.code .gwb-syn-kw { color: var(--gwb-syn-keyword); }
.gwb-dc.code .gwb-syn-str { color: var(--gwb-syn-string); }
.gwb-dc.code .gwb-syn-num { color: var(--gwb-syn-number); }
.gwb-dc.code .gwb-syn-com { color: var(--gwb-syn-comment); font-style: italic; }
.gwb-dc.code .gwb-syn-ann { color: var(--gwb-syn-annotation); }
.gwb-dc.code .gwb-syn-fn { color: var(--gwb-syn-function); }
.gwb-dc.code .gwb-word { border-radius: 2px; }
.gwb-dc.code .gwb-word.add { background: var(--gwb-diff-add-word); }
.gwb-dc.code .gwb-word.del { background: var(--gwb-diff-del-word); }

/* ------------------------------------------------------- blame gutter */

/* min-width on the *wrapper*, not on the rows: a sticky child can only travel
   inside its own containing block, so rows sized to their own content give each
   line a different scroll limit and the gutter stair-steps sideways. One shared
   width keeps every gutter pinned at the same x. */
.gwb-blame { padding: 2px 0 8px; min-width: max-content; }
.gwb-blamerow { display: flex; align-items: stretch; }
.gwb-blamerow.run { margin-top: 3px; }
.gwb-blamerow:hover .gwb-blame-label, .gwb-blamerow:hover .gwb-blame-ln { background: var(--gwb-hover); }
/* Sticky so the code can scroll sideways without losing who wrote the line —
   that is the only thing the view exists for. */
.gwb-blame-label {
  position: sticky; left: 0; z-index: 2; flex: none; width: 148px;
  display: flex; flex-direction: column; justify-content: center; gap: 1px;
  padding: 1px 8px 1px 10px; background: var(--gwb-bg);
  border-right: 1px solid var(--gwb-border);
  font-family: var(--dsw-font-ui-font-family, system-ui, sans-serif); font-size: 11px; line-height: 1.35;
  color: var(--gwb-faint);
}
.gwb-blame-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gwb-dim); }
.gwb-blamerow.fresh .gwb-blame-who { color: var(--gwb-accent-ink); font-weight: 500; }
.gwb-blame-ln {
  position: sticky; left: 148px; z-index: 2; flex: none; width: 40px;
  display: flex; align-items: center; justify-content: flex-end; padding-right: 8px;
  background: var(--gwb-bg); border-right: 1px solid var(--gwb-border);
  color: var(--gwb-faint); font-size: 11px; font-variant-numeric: tabular-nums;
}
.gwb-blame-code { flex: none; white-space: pre; padding: 0 8px; }
.gwb-blame-code .gwb-syn-kw { color: var(--gwb-syn-keyword); }
.gwb-blame-code .gwb-syn-str { color: var(--gwb-syn-string); }
.gwb-blame-code .gwb-syn-num { color: var(--gwb-syn-number); }
.gwb-blame-code .gwb-syn-com { color: var(--gwb-syn-comment); font-style: italic; }
.gwb-blame-code .gwb-syn-ann { color: var(--gwb-syn-annotation); }
.gwb-blame-code .gwb-syn-fn { color: var(--gwb-syn-function); }
.gwb-drow.selected .gwb-dc.code { background: var(--gwb-accent-soft); }
.gwb-drow.selected .gwb-dc.bar.add { background: linear-gradient(to right, var(--gwb-diff-bar-add) 3px, var(--gwb-accent-soft) 3px); }
.gwb-drow.selected .gwb-dc.bar.del { background: linear-gradient(to right, var(--gwb-diff-bar-del) 3px, var(--gwb-accent-soft) 3px); }
.gwb-drow.selected .gwb-dc.ln { color: var(--gwb-accent-ink); background: var(--gwb-accent-soft); }
/* ---- conflict (merge) view ---- */
.gwb-merge { display: flex; flex-direction: column; min-height: 0; }
.gwb-mergebar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px;
  background: var(--gwb-panel); border-bottom: 1px solid var(--gwb-border);
  position: sticky; top: 0; z-index: 3; font-size: 12px; color: var(--gwb-dim);
}
.gwb-merge-region { border-bottom: 1px solid var(--gwb-border); }
/* The three bulk actions wrap as one block: loose buttons used to split across
   the two lines and orphan 全部接受双方 on its own row. */
.gwb-merge-bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.gwb-merge-head { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 11px; color: var(--gwb-dim); }
.gwb-merge-n {
  flex: none; min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; text-align: center;
  border-radius: 9px; background: color-mix(in srgb, var(--gwb-del) 16%, transparent);
  color: var(--gwb-del-ink); font-size: 11px; font-weight: 600;
}
.gwb-merge-cols { display: grid; grid-template-columns: 1fr 1fr; align-items: stretch; }
.gwb-merge[data-narrow="1"] .gwb-merge-cols { grid-template-columns: 1fr; }
.gwb-merge[data-narrow="1"] .gwb-merge-col + .gwb-merge-col { border-left: 0; border-top: 1px solid var(--gwb-border); }
.gwb-merge-col { min-width: 0; }
/* One line-number cell per column: a conflict side has its own numbering. */
.gwb-merge .gwb-drow[data-mode="merge"] { grid-template-columns: 44px 10px minmax(0, 1fr); }
.gwb-merge-col + .gwb-merge-col { border-left: 1px solid var(--gwb-border); }
.gwb-merge-label {
  display: flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 11px;
  color: var(--gwb-dim); border-bottom: 1px solid var(--gwb-border);
}
.gwb-merge-label.ours { color: var(--gwb-add-ink); background: color-mix(in srgb, var(--gwb-diff-add-bg) 60%, transparent); }
.gwb-merge-label.theirs { color: var(--gwb-del-ink); background: color-mix(in srgb, var(--gwb-diff-del-bg) 60%, transparent); }
.gwb-merge-label .gwb-grow { flex: 1 1 auto; }
.gwb-merge-base { max-height: 220px; overflow: auto; border-bottom: 1px solid var(--gwb-border); background: var(--gwb-panel); }
.gwb-merge-agree { padding: 2px 10px; font-size: 11px; color: var(--gwb-faint); }
/* Hand-edited result: free text under the two sides, monospace like the code. */
.gwb-merge-edit { border-top: 1px solid var(--gwb-border); background: var(--gwb-panel); padding-bottom: 8px; }
.gwb-merge-text {
  display: block; width: calc(100% - 16px); margin: 6px 8px; min-height: 64px; resize: vertical;
  padding: 6px 8px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12)); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, var(--gwb-bg)); color: inherit;
  font-family: var(--gwb-mono); font-size: 12px; line-height: 1.5; outline: none;
}
.gwb-merge-text:focus { border-color: var(--gwb-accent); }
.gwb-merge-editactions { display: flex; align-items: center; gap: 8px; padding: 0 8px; }
.gwb-merge-editactions .gwb-faint { margin-right: auto; font-size: 11px; }
.gwb-turnbar { display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: var(--gwb-accent-soft); border-bottom: 1px solid var(--gwb-border); font-size: 12px; color: var(--gwb-dim); }
.gwb-turntag { padding: 0 6px; height: 17px; line-height: 17px; border-radius: 3px; background: var(--gwb-accent); color: var(--gwb-on-hue); font-size: 10.5px; flex: none; }
.gwb-ovhead { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px; background: var(--gwb-panel); border-bottom: 1px solid var(--gwb-border); position: sticky; top: 0; z-index: 4; }
/* Turn snapshot: file header, then its split version labels, stack while scrolling. */
.gwb-turnfile .gwb-diffside { top: 26px; z-index: 3; }
.gwb-ovpath { font-family: var(--gwb-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------------------------------------------------------------- menus */

.gwb-menu-anchor { position: relative; display: inline-flex; min-width: 0; max-width: 100%; overflow: visible; }
/* A flex item's automatic minimum size is its min-content width, which for a
   chip is the whole branch name; without this the anchor could never shrink. */
.gwb-menu-trigger { display: inline-flex; min-width: 0; max-width: 100%; }
/* Fixed, not absolute: the popup is positioned from the trigger's viewport
   rect in Menu's placement effect. Kept inside the host subtree it would widen
   that container's scrollable area and the autoFocus would scroll the page. */
.gwb-menu {
  position: fixed; top: 0; left: 0; z-index: 80; box-sizing: border-box;
  width: 320px; max-width: min(92vw, 420px); max-height: min(440px, 70vh);
  /* A popup never scrolls sideways: long names ellipsize instead. The search
     input used to add 22px of content-box padding here, which produced a
     horizontal scrollbar whenever the menu lived outside .gwb. */
  overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  background: var(--gwb-bg); color: var(--gwb-text);
  font-family: inherit; font-size: 12px; line-height: 1.45;
  border: 1px solid var(--gwb-border); border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,.18); padding: 6px 8px;
}
.gwb-menu .gwb-menu-title {
  padding: 7px 12px 3px; color: var(--gwb-faint); font-size: 10.5px; font-weight: 600;
  letter-spacing: .04em;
}
.gwb-menu .gwb-menu-row {
  display: flex; align-items: center; gap: 9px; min-height: 26px; padding: 0 12px;
  border-radius: 5px; cursor: pointer; white-space: nowrap;
}
.gwb-menu .gwb-menu-row:hover { background: var(--gwb-hover); }
/* Rows are moved through with the arrow keys by script (tabIndex -1), so a
   hover-only highlight left keyboard users navigating blind. */
.gwb-menu .gwb-menu-row:focus-visible { outline: 2px solid var(--gwb-accent); outline-offset: -2px; background: var(--gwb-hover); }
.gwb-menu .gwb-menu-row.current { font-weight: 600; }
.gwb-menu .gwb-menu-row.danger { color: var(--gwb-error-ink); }
.gwb-rowicon { width: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; text-align: center; color: var(--gwb-dim); font-size: 12px; }
.gwb-menu .gwb-menu-row .gwb-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gwb-menu .gwb-menu-row .gwb-meta {
  flex: 0 1 auto; max-width: 44%; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; text-align: right; color: var(--gwb-faint); font-size: 11px;
}
.gwb-menu .gwb-menu-sep { height: 1px; margin: 5px 10px; background: var(--gwb-border); }
.gwb-ctx .gwb-menu-row { min-height: 28px; }
.gwb-ctx .gwb-menu-row .gwb-meta {
  font-family: var(--gwb-mono); font-size: 10.5px; padding: 0 5px; border-radius: 4px;
  /* Wide enough for a remote url: the push target picker shows them. */
  background: var(--gwb-hover); color: var(--gwb-dim); max-width: 210px;
}
.gwb-menu-row.gwb-muted { color: var(--gwb-faint); cursor: default; }
.gwb-menu-row.gwb-muted:hover { background: none; }
.gwb-menu input {
  width: 100%; height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12));
  border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3, var(--gwb-bg)); outline: none;
  /* Portalled menus live outside .gwb: the browser's default input font and
     colour would leak in (Arial, near-black text on dark themes). */
  font-family: inherit; font-size: 13px; color: var(--gwb-text);
}
.gwb-menu input:focus { border-color: var(--gwb-accent); }

/* Search + operations stay pinned while the branch list underneath scrolls.
   Negative margins stretch the sticky band over the menu's own padding. */
.gwb-menu .gwb-menu-sticky {
  position: sticky; top: -6px; z-index: 6;
  margin: -6px -8px 0; padding: 6px 8px 4px;
  background: var(--gwb-bg);
  border-bottom: 1px solid var(--gwb-border);
}
.gwb-menu .gwb-menu-search { padding: 0 2px 8px; }
.gwb-menu .gwb-menu-sticky .gwb-menu-actions { margin-bottom: 0; border-bottom: 0; }

/* The repo operations read as one compact tool strip: five equal cells, an
   16px glyph over its label, all monochrome. The old cells stacked a 12px
   glyph inside a 26px box and grew to 61px tall, twice a list row. */
.gwb-menu .gwb-menu-actions {
  display: flex; gap: 2px; padding: 3px;
  border-bottom: 1px solid var(--gwb-border); margin-bottom: 4px;
}
.gwb-menu .gwb-menu-actions .gwb-menu-row {
  flex: 1 1 0; flex-direction: column; justify-content: center; gap: 3px;
  min-width: 0; min-height: 24px; padding: 4px 2px; border-radius: 6px;
  font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden;
}
.gwb-menu .gwb-action-line { display: inline-flex; align-items: center; justify-content: center; gap: 2px; max-width: 100%; min-width: 0; }
.gwb-menu .gwb-action-label { display: block; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-menu .gwb-menu-actions .gwb-menu-row .gwb-rowicon {
  width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
}
/* Each operation cell keeps the same neutral glyph: a hue per position would
   make the strip look like five different kinds of control. */
.gwb-menu .gwb-action-cell { display: flex; flex: 1 1 0; min-width: 0; }
.gwb-menu .gwb-action-cell .gwb-menu-row { flex: 1 1 auto; }
.gwb-menu .gwb-menu-actions .gwb-menu-row:hover .gwb-rowicon { filter: brightness(.96); }
/* The cell that launched the operation still running stays marked, so reopening
   the menu answers "did my click land?" before the user tries it again. */
.gwb-menu .gwb-action-cell.busy .gwb-menu-row { background: var(--gwb-accent-soft); }
.gwb-menu .gwb-action-cell.busy .gwb-action-label { color: var(--gwb-accent-ink); }
/* Label and caret stay one inline unit under the icon. The caret used to sit
   outside the cell, absolutely positioned, where the row's overflow cut it. */
.gwb-menu .gwb-action-caret {
  flex: none; width: 14px; height: 16px; margin-right: -2px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 3px; color: var(--gwb-dim); font-size: 11px; line-height: 1; cursor: pointer;
  font-family: inherit; background: none; border: 0; padding: 0;
}
.gwb-menu .gwb-action-caret:hover { color: var(--gwb-text); background: color-mix(in srgb, var(--gwb-text) 12%, transparent); }

/* Every branch and commit row carries one permanent "all actions" trigger.
   The branch row used to show a single merge button, and only while hovered —
   which read as "there is nothing else here". */
.gwb-rowmore {
  flex: none; width: 20px; height: 20px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 4px; background: none;
  color: var(--gwb-faint); cursor: pointer;
}
.gwb-rowmore:hover { background: color-mix(in srgb, var(--gwb-text) 12%, transparent); color: var(--gwb-text); }
.gwb-rowmore:focus-visible { outline: 2px solid var(--gwb-accent); outline-offset: -2px; }
.gwb-menu .gwb-menu-row .gwb-rowmore { margin-left: 2px; margin-right: -6px; }
.gwb-logrow .gwb-rowmore { margin-left: -2px; margin-right: -4px; }

/* context menus and name prompts are portalled to <body> */
.gwb-menu.gwb-ctx { min-width: 220px; max-width: min(360px, calc(100vw - 16px)); }

.gwb-toast {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 200;
  padding: 7px 14px; border-radius: var(--dsw-radius-sm, 8px); background: var(--gwb-text); color: var(--gwb-bg);
  font-size: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.25); max-width: 70vw;
  /* Toasts sit over the commit bar; they must never eat clicks there. */
  pointer-events: none;
  /* Error messages must stay readable: wrap instead of truncating. Git's own
     narrative is multi-line and columnar, so it reads as a log, not a caption. */
  white-space: pre-wrap; word-break: break-word; text-align: left;
}
.gwb-toast.error { background: var(--gwb-del); color: var(--gwb-on-hue); padding-right: 30px; }
/* Only the ✕ takes clicks, so an error can stay put over the commit bar
   without stealing the clicks that belong to it. */
.gwb-toast-x {
  position: absolute; top: 4px; right: 5px; display: none;
  width: 18px; height: 18px; padding: 0; border: 0; border-radius: 3px;
  background: transparent; color: inherit; font-family: inherit; font-size: 12px;
  line-height: 18px; cursor: pointer; opacity: .8; pointer-events: auto;
}
.gwb-toast-x:hover { opacity: 1; background: color-mix(in srgb, currentColor 18%, transparent); }
.gwb-toast-x:focus-visible { outline: 2px solid var(--gwb-accent); outline-offset: 1px; }

/* Hero option row (new session only). Matches the host's WorkspaceChip:
   28px tall, 13px/500, no border, 4px gap, 16px icon, 14px chevron. Rendered
   in a host slot, outside .gwb — no button reset applies, so font/cursor are
   declared here. */
.gwb-hero-chip {
  display: inline-flex; align-items: center; gap: 4px; min-height: 28px;
  /* Long branch names must not push the row wide: the label ellipsises and the
     full name is in the tooltip. */
  max-width: 168px; padding: 0 8px; border: 0; cursor: pointer;
  border-radius: var(--dsw-radius-sm, 6px); background: transparent; font-family: inherit;
  color: var(--dsw-alias-label-primary, #1f2328); font-size: 13px; font-weight: 500; line-height: 20px;
}
.gwb-hero-chip:hover { background: var(--gwb-hover); }
.gwb-hero-chip svg { flex: none; }
.gwb-hero-chip .gwb-hero-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-hero-chip .gwb-hero-chip-chevron { flex: none; color: var(--gwb-faint); font-size: 10px; line-height: 1; }

.gwb-chipbtn {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px;
  border: 0; border-radius: 4px; background: transparent;
  color: var(--gwb-dim);
  font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1.4;
  white-space: nowrap; cursor: pointer;
  /* The session header row is content-sized, so an uncapped branch name would
     push it wide and squeeze the conversation next to it. */
  max-width: 168px; min-width: 0;
}
.gwb-chipbtn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-chipbtn:hover { background: var(--gwb-hover); color: var(--gwb-text); }

/* A network operation runs after the menu has already closed, so the trigger it
   was launched from is the only place left that can say "still working". The
   factories set aria-busy; the pulse makes the replaced label read as progress
   rather than a new branch name, and cursor:progress warns that a second git
   command on this repo would only race the first over index.lock. */
.gwb-chip[aria-busy="1"],
.gwb-chipbtn[aria-busy="1"],
.gwb-hero-chip[aria-busy="1"] {
  background: var(--gwb-accent-soft); cursor: progress;
  animation: gwb-busy 1.1s ease-in-out infinite;
}
.gwb-chip[aria-busy="1"] .gwb-caret,
.gwb-hero-chip[aria-busy="1"] .gwb-hero-chip-chevron { opacity: 0.35; }
@keyframes gwb-busy { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) {
  .gwb-chip[aria-busy="1"],
  .gwb-chipbtn[aria-busy="1"],
  .gwb-hero-chip[aria-busy="1"] { animation: none; }
}

/* ------------------------------------------------------------- settings */

.gwb-settings-section { display: flex; flex-direction: column; gap: 12px; }
/* The host's own section headings (包含的组件 / 来源信息) are 14px/500. */
.gwb-settings-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary, #1f2328); }
.gwb-settings { display: flex; flex-direction: column; gap: 2px; max-width: 640px; color: var(--dsw-alias-label-primary, #1f2328); font-size: 13px; }
/* Only the intro paragraph carries a bottom margin; hints inside a row or
   the footer sit flush under their label. */
.gwb-settings > .gwb-settings-hint { margin: 0 0 4px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; }
/* Host fact rows: 8px padding and a .5px border-l2 hairline. */
.gwb-settings .gwb-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 2px; border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06)); }
.gwb-settings .gwb-settings-row:last-of-type { border-bottom: 0; }
.gwb-settings-group { display: flex; flex-direction: column; gap: 2px; margin-top: 20px; }
.gwb-settings-group-title {
  margin: 0 0 2px; padding-bottom: 6px; border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06));
  font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-secondary, #5b6068);
}
.gwb-settings .gwb-settings-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gwb-settings .gwb-settings-text .gwb-settings-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; }
.gwb-settings .gwb-settings-label { font-weight: 500; }
.gwb-settings .gwb-settings-control { flex: none; display: flex; align-items: center; }
/* Host input spec: 34px, .5px border-l4, radius-md, layer-3 fill. */
.gwb-settings input[type="text"], .gwb-settings input[type="number"], .gwb-settings select {
  box-sizing: border-box; height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12));
  border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3, #fff);
  color: inherit; font: inherit; font-size: 13px; line-height: 1.5; outline: none;
}
.gwb-settings input[type="text"] { width: 260px; }
.gwb-settings input[type="number"] { width: 100px; }
.gwb-settings input:focus, .gwb-settings select:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
/* Host switch: 36×20 pill, 16px thumb; brand-primary when on. */
.gwb-settings .gwb-switch {
  box-sizing: border-box; position: relative; flex: none; width: 36px; height: 20px; padding: 2px;
  border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, rgba(0,0,0,.14));
  cursor: pointer;
}
.gwb-settings .gwb-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #0f1115); }
.gwb-settings .gwb-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 2px;
}
.gwb-settings .gwb-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff); transition: transform .12s ease;
}
.gwb-settings .gwb-switch[aria-checked="true"] .gwb-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #fff); transform: translate(16px);
}
/* The host scrolls the settings tab inside a fixed-height dialog, so 保存 has
   to ride the bottom edge instead of waiting below twelve rows. The plugin
   page scrolls as one document, so its footer stays at the end of the form. */
.gwb-settings:not(.gwb-settings--page) .gwb-settings-footer {
  position: sticky; bottom: 0; z-index: 1;
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.gwb-settings .gwb-settings-footer {
  display: flex; align-items: center; gap: 12px; padding: 12px 0 4px;
  border-top: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06));
}
/* Sticky stops at the dialog's content box, which leaves its bottom padding as
   a sliver of rows under the bar. Bleed the same background over that band so
   the bar reads as flush with the dialog edge whatever that padding is. */
.gwb-settings:not(.gwb-settings--page) .gwb-settings-footer::after {
  content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 32px;
  background: inherit;
}
.gwb-settings .gwb-settings-footer .gwb-settings-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; }
/* Host primary button (md): 36px, radius-md, button-primary tokens. */
.gwb-settings .gwb-settings-save {
  height: 36px; padding: 0 14px; border-radius: var(--dsw-radius-md, 8px); border: 0; cursor: pointer;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #4176e6));
  color: var(--dsw-alias-label-primary-foreground, var(--gwb-on-hue)); font-size: 14px; line-height: 22px;
}
.gwb-settings .gwb-settings-save:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 88%, #000));
}
.gwb-settings .gwb-settings-save:disabled { opacity: .4; cursor: not-allowed; }

/* ------------------------------------------------- confirm (portalled) */

.gwb-confirm-backdrop {
  position: fixed; inset: 0; z-index: 205; background: rgba(0,0,0,.28);
  display: flex; align-items: center; justify-content: center;
}
.gwb-confirm {
  min-width: 280px; max-width: min(420px, 92vw); padding: 16px;
  background: var(--gwb-bg); color: var(--gwb-text);
  border: .5px solid var(--dsw-alias-border-l3, var(--gwb-border)); border-radius: var(--dsw-radius-md, 12px);
  box-shadow: 0 12px 32px rgba(0,0,0,.22); font-size: 13px;
}
/* Dialog actions take the host's small-button metrics: 32px tall next to the
   34px fields, not the 24px toolbar size. */
.gwb-confirm .gwb-btn { height: 32px; padding: 0 14px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; }
.gwb-confirm .gwb-confirm-msg { margin-bottom: 12px; line-height: 1.5; }
.gwb-confirm .gwb-confirm-row { display: flex; justify-content: flex-end; gap: 8px; }
/* An optional second half of the destructive action sits between the question
   and the buttons, so it reads as part of what is being confirmed. */
.gwb-confirm .gwb-confirm-option { display: flex; align-items: center; gap: 7px; margin: 0 0 14px; font-size: 12px; color: var(--gwb-dim); cursor: pointer; user-select: none; }
/* "确定" in the same blue as 保存 for an action that deletes work. The verb
   goes on the button and it takes the error colour; focus stays on 取消. */
.gwb-confirm .gwb-btn.danger { background: var(--dsw-alias-state-error-primary, #ec1313); color: var(--gwb-on-hue); }
.gwb-confirm .gwb-btn.danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 88%, #000); }

/* --------------------------------------------------------- stash dialog */

.gwb-stash-dialog { width: min(480px, 92vw); max-width: min(480px, 92vw); display: flex; flex-direction: column; gap: 6px; }
.gwb-stash-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.gwb-stash-label { font-size: 11px; color: var(--gwb-dim); }
.gwb-stash-input {
  height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12)); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, var(--gwb-bg)); color: inherit; font: inherit; font-size: 13px; outline: none;
}
.gwb-stash-input:focus { border-color: var(--gwb-accent); }
.gwb-stash-hint { font-size: 11px; color: var(--gwb-faint); }
.gwb-stash-files-head { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.gwb-stash-files-head .gwb-btn.sm { height: 20px; }
.gwb-stash-list {
  max-height: min(38vh, 260px); overflow: auto; padding: 2px;
  border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12)); border-radius: var(--dsw-radius-sm, 8px);
}
.gwb-stash-file { display: flex; align-items: center; gap: 7px; height: 24px; padding: 0 6px; border-radius: 4px; cursor: pointer; font-size: 12px; min-width: 0; }
.gwb-stash-file:hover { background: var(--gwb-hover); }
.gwb-stash-file input[type="checkbox"],
.gwb-identity-scope input[type="checkbox"],
.gwb-confirm-option input[type="checkbox"] {
  appearance: none; -webkit-appearance: none; width: 13px; height: 13px; margin: 0; flex: none;
  border: 1.5px solid color-mix(in srgb, var(--gwb-dim) 55%, transparent); border-radius: 3px;
  background: var(--gwb-bg); display: inline-grid; place-content: center; cursor: pointer;
}
.gwb-stash-file input[type="checkbox"]:checked,
.gwb-identity-scope input[type="checkbox"]:checked,
.gwb-confirm-option input[type="checkbox"]:checked { background: var(--gwb-accent); border-color: var(--gwb-accent); }
.gwb-stash-file input[type="checkbox"]:checked::after,
.gwb-identity-scope input[type="checkbox"]:checked::after,
.gwb-confirm-option input[type="checkbox"]:checked::after {
  content: ''; width: 7px; height: 3.5px; border-left: 1.5px solid #fff; border-bottom: 1.5px solid #fff;
  transform: rotate(-45deg) translateY(-1px);
}
.gwb-stash-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-stash-dir { color: var(--gwb-faint); }
.gwb-stash-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.gwb-stash-count { margin-right: auto; font-size: 11px; color: var(--gwb-dim); }
.gwb-stash-count.error { color: var(--gwb-error-ink); }
.gwb-identity-scope { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--gwb-dim); cursor: pointer; }
.gwb-identity-scope input[type="checkbox"] { cursor: pointer; }

/* ------------------------------------------------------- remotes manager */

.gwb-remotes {
  width: min(520px, 94vw); max-width: min(520px, 94vw);
  display: flex; flex-direction: column; gap: 8px; padding: 16px;
  background: var(--gwb-bg); color: var(--gwb-text);
  border: .5px solid var(--dsw-alias-border-l3, var(--gwb-border)); border-radius: var(--dsw-radius-md, 12px);
  box-shadow: 0 12px 32px rgba(0,0,0,.22); font-size: 12px;
}
.gwb-remotes-title { font-size: 13px; font-weight: 600; }
.gwb-remotes-list {
  display: flex; flex-direction: column; gap: 4px;
  max-height: min(40vh, 280px); overflow: auto;
}
.gwb-remote {
  display: grid; grid-template-columns: minmax(72px, auto) 1fr auto; align-items: center; gap: 10px;
  min-height: 30px; padding: 4px 6px; border: 1px solid var(--gwb-border); border-radius: var(--dsw-radius-sm, 8px);
}
.gwb-remote:hover { background: var(--gwb-hover); }
.gwb-remote-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-remote-url {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--gwb-dim); font-family: var(--gwb-mono, monospace); font-size: 11px;
}
.gwb-remote-actions { display: flex; gap: 6px; }
.gwb-remote-actions .gwb-btn.sm { height: 22px; padding: 0 8px; font-size: 11px; }
.gwb-remotes-empty {
  padding: 14px 10px; text-align: center; color: var(--gwb-dim);
  border: 1px dashed var(--gwb-border); border-radius: var(--dsw-radius-sm, 8px);
}
.gwb-remotes-error {
  display: none; padding: 6px 8px; border-radius: 6px; font-size: 12px; line-height: 1.45;
  color: var(--gwb-error-ink);
  background: color-mix(in srgb, var(--gwb-error) 10%, transparent);
}
.gwb-remotes-error.visible { display: block; }
.gwb-remote-form { display: flex; flex-direction: column; gap: 4px; }
/* These rows carry their own display, which would beat the [hidden] default. */
.gwb-remotes [hidden] { display: none; }
.gwb-remote-label { font-size: 11px; color: var(--gwb-dim); }
.gwb-remote-input {
  height: 34px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12)); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, var(--gwb-bg)); color: inherit; font: inherit; font-size: 13px; outline: none;
}
.gwb-remote-input:focus { border-color: var(--gwb-accent); }
.gwb-remote-form .gwb-prompt-hint { font-size: 11px; color: var(--gwb-faint); }
.gwb-remote-form .gwb-prompt-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.gwb-remotes-foot { display: flex; justify-content: flex-end; gap: 8px; }
.gwb-remotes-foot .gwb-btn, .gwb-remote-form .gwb-prompt-row .gwb-btn {
  height: 32px; padding: 0 14px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px;
}

/* --------------------------------------------------------- reword dialog */

.gwb-reword-dialog { width: min(560px, 94vw); max-width: min(560px, 94vw); }
.gwb-reword-input {
  height: 132px; padding: 10px 12px; resize: vertical; line-height: 1.55;
  white-space: pre-wrap; overflow: auto;
}
.gwb-reword-input.is-invalid { border-color: var(--gwb-error); }
.gwb-reword-error { min-height: 14px; font-size: 11px; color: var(--gwb-error-ink); }

/* --------------------------------------------------------- rebase dialog */

.gwb-rebase-dialog { width: min(620px, 94vw); max-width: min(620px, 94vw); display: flex; flex-direction: column; gap: 6px; }
.gwb-rebase-title { font-size: 13px; font-weight: 600; }
.gwb-rebase-sub { margin-top: -3px; font-size: 11px; color: var(--gwb-dim); }
.gwb-rebase-list {
  max-height: min(46vh, 360px); overflow: auto; padding: 2px;
  border: 1px solid var(--gwb-border); border-radius: 6px;
}
.gwb-rebase-row {
  display: grid; grid-template-columns: 20px 88px 58px minmax(0, 1fr) 46px;
  align-items: center; gap: 6px; min-height: 29px; padding: 0 5px; border-radius: 4px;
  font-size: 12px;
}
.gwb-rebase-row + .gwb-rebase-row { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--gwb-border) 55%, transparent); }
.gwb-rebase-row:hover { background: var(--gwb-hover); }
.gwb-rebase-index { font-size: 10px; color: var(--gwb-faint); text-align: right; font-variant-numeric: tabular-nums; }
.gwb-rebase-action {
  width: 100%; height: 22px; padding: 0 3px; border: 1px solid var(--gwb-border); border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1, var(--gwb-bg)); color: inherit; font: inherit; font-size: 11px;
  outline: none; cursor: pointer;
}
.gwb-rebase-action:focus { border-color: var(--gwb-accent); }
.gwb-rebase-row.is-fold .gwb-rebase-action { color: var(--gwb-accent-ink); border-color: color-mix(in srgb, var(--gwb-accent) 45%, var(--gwb-border)); }
.gwb-rebase-hash { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: var(--gwb-dim); overflow: hidden; text-overflow: ellipsis; }
.gwb-rebase-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-rebase-row.is-drop .gwb-rebase-subject { text-decoration: line-through; color: var(--gwb-faint); }
.gwb-rebase-row.is-drop .gwb-rebase-hash { opacity: .55; }
.gwb-rebase-moves { display: inline-flex; gap: 1px; justify-content: flex-end; }
.gwb-rebase-move {
  width: 21px; height: 21px; padding: 0; display: inline-grid; place-content: center;
  border: 0; border-radius: 4px; background: transparent; color: var(--gwb-dim); cursor: pointer;
}
.gwb-rebase-move:hover:not(:disabled) { background: var(--gwb-accent-soft); color: var(--gwb-accent-ink); }
.gwb-rebase-move:disabled { opacity: .22; cursor: default; }
.gwb-rebase-hint { font-size: 11px; line-height: 1.45; color: var(--gwb-faint); }
.gwb-rebase-error { min-height: 15px; font-size: 11px; color: var(--gwb-error-ink); }
.gwb-rebase-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.gwb-rebase-keep { margin-right: auto; font-size: 11px; color: var(--gwb-dim); }
.gwb-rebase-keep.error { color: var(--gwb-error-ink); }

/* ------------------------------------------------- floating name prompt */

.gwb-prompt { padding: 2px 8px 8px; display: flex; flex-direction: column; gap: 4px; }
.gwb-prompt input.invalid { border-color: var(--dsw-alias-state-error-primary, #ec1313); }
.gwb-prompt-hint { font-size: 11px; color: var(--gwb-faint); }
.gwb-prompt-hint.error { color: var(--gwb-error-ink); }
.gwb-prompt-row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.gwb-prompt-row .gwb-btn { height: 28px; padding: 0 12px; border-radius: var(--dsw-radius-sm, 8px); }

/* -------------------------------------------------------- compact panes */

.gwb[data-compact="1"] .gwb-chip .gwb-chip-label { max-width: 120px; }
.gwb[data-compact="1"] .gwb-chip .gwb-chip-meta { display: none; }
.gwb[data-compact="1"] .gwb-head { gap: 2px; }
.gwb[data-compact="1"] .gwb-btn { padding: 0 6px; }
/* --------------------------------------------------------------- console */
.gwb-console-hint { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gwb-faint); font-size: 11px; }
.gwb-console-row { border-bottom: 1px solid var(--gwb-border); }
.gwb-console-row.failed { background: color-mix(in srgb, var(--gwb-del) 5%, transparent); }
.gwb-console-cmd { display: flex; align-items: center; gap: 7px; padding: 4px 10px; cursor: pointer; font-family: var(--gwb-mono); font-size: 12px; line-height: 1.7; }
.gwb-console-cmd:hover { background: var(--gwb-hover); }
.gwb-console-caret { flex: none; width: 10px; color: var(--gwb-faint); }
.gwb-console-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gwb-console-code { flex: none; padding: 0 5px; border-radius: 7px; font-size: 10px; color: var(--gwb-faint); background: color-mix(in srgb, var(--gwb-text) 6%, transparent); }
.gwb-console-code.bad { color: var(--gwb-del-ink); background: color-mix(in srgb, var(--gwb-del) 14%, transparent); }
.gwb-console-code.run { color: var(--gwb-accent-ink); background: var(--gwb-accent-soft); }
.gwb-console-count { padding: 0 5px; border-radius: 7px; background: color-mix(in srgb, var(--gwb-text) 6%, transparent); }
.gwb-console-meta { flex: none; font-size: 10px; color: var(--gwb-faint); font-variant-numeric: tabular-nums; }
.gwb-console-out { padding: 2px 10px 8px 27px; background: color-mix(in srgb, var(--gwb-text) 3%, transparent); }
.gwb-console-out pre { margin: 0; padding: 3px 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--gwb-mono); font-size: 11px; line-height: 1.55; }
.gwb-console-stderr { color: var(--gwb-del-ink); }
.gwb-console-none { padding: 3px 0; color: var(--gwb-faint); font-size: 11px; }
.gwb[data-compact="1"] .gwb-console-hint, .gwb[data-compact="1"] .gwb-console-meta { display: none; }

/* Log: below ~640px the list/detail pair stacks instead of squeezing both. */
.gwb[data-compact="1"] .gwb-log-split { flex-direction: column; }
.gwb[data-compact="1"] .gwb-log-list { flex: 0 0 46%; min-height: 0; border-right: 0; border-bottom: 1px solid var(--gwb-border); }
.gwb[data-compact="1"] .gwb-log-detail { flex: 1 1 auto; min-height: 0; }
/* Nothing picked: the hint is one line, so let the log own the panel. Placed after the compact rules so it wins the specificity tie. */
.gwb-log-split.nosel { flex-direction: column; }
.gwb-log-split.nosel .gwb-log-list { flex: 1 1 auto; min-height: 0; border-right: 0; }
.gwb-log-split.nosel .gwb-log-detail { flex: none; }
.gwb[data-compact="1"] .gwb-log-graph { width: var(--gwb-col-graph, 30px); }
/* A narrow list column cannot hold every column: the author gives way before
   the subject does, and the header drops it with it so the two stay aligned.
   The list's own width decides — a full-width list in a narrow pane still
   has room for the author. */
.gwb-log-list[data-narrow="1"] .gwb-logrow .gwb-author,
.gwb-log-list[data-narrow="1"] .gwb-logcols .gwb-author { display: none; }
.gwb-log-list[data-tight="1"] .gwb-logrow .gwb-hash,
.gwb-log-list[data-tight="1"] .gwb-logcols .gwb-hash { display: none; }

/* Diff: a narrow pane keeps the toolbar usable by dropping secondary text. */
.gwb[data-narrow="1"] .gwb-difftoolbar { gap: 4px; }
.gwb[data-narrow="1"] .gwb-difftoolbar .gwb-btn.sm { padding: 0 6px; }
.gwb[data-narrow="1"] .gwb-hunksection { display: none; }
.gwb[data-narrow="1"] .gwb-diffstats .gwb-diffstats-sep { display: none; }
.gwb[data-narrow="1"] .gwb-diffnav .gwb-navcount { min-width: 44px; }
.gwb[data-narrow="1"] .gwb-diffname .gwb-crumb-dir, .gwb[data-narrow="1"] .gwb-diffname .gwb-crumb-sep { display: none; }
.gwb[data-narrow="1"] .gwb-readonly:not(.gwb-ws-lock) { display: none; }

/* ---------------------------------------------------- review batch 2 */
/* A row that cannot be clicked must not answer the pointer. */
.gwb-menu .gwb-menu-row.gwb-noclick { cursor: default; }
.gwb-menu .gwb-menu-row.gwb-noclick:hover { background: none; }
/* Small glyph controls keep their size but inherit a real hit area. */
.gwb-fchip-x, .gwb-search-caret, .gwb-menu .gwb-action-caret,
.gwb-settings input[type="checkbox"], .gwb-stash-file input[type="checkbox"],
.gwb-confirm-option input[type="checkbox"] { position: relative; }
.gwb-fchip-x::before, .gwb-search-caret::before, .gwb-menu .gwb-action-caret::before,
.gwb-settings input[type="checkbox"]::before, .gwb-stash-file input[type="checkbox"]::before,
.gwb-confirm-option input[type="checkbox"]::before {
  content: ''; position: absolute; inset: -4px;
}
.gwb-settings input[type="checkbox"] { cursor: pointer; }
.gwb-settings input[type="checkbox"]:hover, .gwb-stash-file input[type="checkbox"]:hover,
.gwb-confirm-option input[type="checkbox"]:hover { border-color: var(--gwb-accent); }
.gwb-settings input[type="checkbox"]:focus-visible, .gwb-stash-file input[type="checkbox"]:focus-visible,
.gwb-confirm-option input[type="checkbox"]:focus-visible,
.gwb-file input[type="checkbox"]:focus-visible, .gwb-check input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--gwb-accent); outline-offset: 1px;
}
/* A diff bar only stages where a click is wired up. */
.gwb-dc.bar.inert { cursor: default; }
.gwb-dc.bar.inert:hover { background: transparent; }
/* Count pills all sit on the same ladder: small rects 4px, pills fully round. */
.gwb-opchip, .gwb-merge-n, .gwb-console-code, .gwb-console-count { border-radius: 999px; }

`

    const DARK_OVERRIDES = `
body[data-ds-dark-theme] .gwb-menu { box-shadow: 0 8px 24px rgba(0,0,0,.5); }
body[data-ds-dark-theme] .gwb-confirm { box-shadow: 0 12px 32px rgba(0,0,0,.55); }
body[data-ds-dark-theme] .gwb-confirm-backdrop { background: rgba(0,0,0,.45); }
`

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="@yann9/dsh-git-workbench/styles"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@yann9/dsh-git-workbench'
      tag.dataset.pluginCss = '@yann9/dsh-git-workbench/styles'
      tag.textContent = STYLES + DARK_OVERRIDES
      document.head.appendChild(tag)
    }
    return { STYLES, DARK_OVERRIDES, injectStyles }
  },
})
