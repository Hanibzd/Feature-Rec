/**
 * GOLDEN EXAMPLE — "Rename workspace from settings".
 * Archetype: a flow. The pointer opens a dialog, types a name, the primary button
 * becomes enabled. The dialog is a <Modal>: its backdrop covers the whole screen.
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import { z } from "zod";
import { Modal, Stage, Typewriter, useProgress } from "../index";
import { fontFamily } from "../../font";

export const schema = z.object({
  current: z.string().default("Acme Inc"),
  next: z.string().default("Acme Labs"),
});

export default function Scene(props: Partial<z.infer<typeof schema>>) {
  const { current, next } = schema.parse(props ?? {});
  const frame = useCurrentFrame();
  // Timeline: overview (0-28) → pointer to "Rename" (28-52) → click 54 → dialog opens →
  // pointer to the input (66-80) → click 82 → typing 86-120 → pointer to Save (124-146) → hover/hold.
  const open = useProgress(56, 14);
  const nameTyped = frame >= 86 + Math.ceil((next.length / 14) * 30); // Save enables once typed

  return (
    <Stage
      fontFamily={fontFamily}
      background="#FAFAFA" // the page background: no page-sized box is drawn
      pointer={{
        path: [
          { frame: 0, to: { x: 1180, y: 820 } },
          { frame: 28, to: { x: 1180, y: 820 } },
          { frame: 52, to: "rename" },
          { frame: 66, to: "rename" },
          { frame: 80, to: "name-input" },
          { frame: 124, to: "name-input" },
          { frame: 146, to: "save" },
        ],
        clicks: [54, 82],
      }}
    >
      {({ hovered, pressed }) => (
        <div className="flex justify-center pt-32">
          <section data-focus="ui" className="w-[640px]">
            <h1 className="text-xl font-semibold text-zinc-900">Settings</h1>
            <div className="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Workspace</p>
                  <h2 className="mt-1 text-lg font-semibold text-zinc-900">{current}</h2>
                </div>
                <button
                  data-focus="rename"
                  className={`rounded-lg px-3 py-2 text-sm font-medium text-zinc-800 ring-1 ring-zinc-200 ${
                    pressed("rename") ? "bg-zinc-100" : hovered("rename") ? "bg-zinc-50" : "bg-white"
                  }`}
                >
                  Rename
                </button>
              </div>
              <p className="mt-4 text-sm leading-6 text-zinc-500">
                The workspace name appears in invitations, emails and the sidebar.
              </p>
            </div>
          </section>

          <Modal open={open}>
            <div className="w-[420px] rounded-xl bg-white p-5 shadow-xl ring-1 ring-zinc-200">
              <h3 className="text-base font-semibold text-zinc-900">Rename workspace</h3>
              <label className="mt-4 block text-sm font-medium text-zinc-700">Name</label>
              <div
                data-focus="name-input"
                data-cursor="text"
                className={`mt-1.5 h-10 rounded-lg px-3 text-sm leading-10 text-zinc-900 ${
                  frame >= 82 ? "ring-2 ring-zinc-900" : "ring-1 ring-zinc-300"
                }`}
              >
                <Typewriter text={next} from={86} focusAt={82} />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200">Cancel</button>
                <button
                  data-focus="save"
                  className={`rounded-lg px-3 py-2 text-sm font-medium text-white ${
                    nameTyped ? (hovered("save") ? "bg-zinc-700" : "bg-zinc-900") : "bg-zinc-900/40"
                  }`}
                >
                  Save
                </button>
              </div>
            </div>
          </Modal>
        </div>
      )}
    </Stage>
  );
}
