/**
 * GOLDEN EXAMPLE — "Add 'Copy invite link' to the team card".
 * Archetype: a new control appears, then the pointer shows how it works.
 */
import React from "react";
import { z } from "zod";
import { Reveal, Stage, Swap } from "../index";
import { fontFamily } from "../../font";

export const schema = z.object({
  team: z.string().default("Design team"),
});

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
const LinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
);

const people = [
  ["AL", "Ada Lovelace", "Owner"],
  ["GH", "Grace Hopper", "Editor"],
  ["KJ", "Katherine Johnson", "Viewer"],
];

export default function Scene(props: Partial<z.infer<typeof schema>>) {
  const { team } = schema.parse(props ?? {});
  // Timeline (frames): overview → button appears (30) → pointer moves (60→88) → click (92) → "Copied" (94) → hold.
  return (
    <Stage
      fontFamily={fontFamily}
      background="#F4F4F5"
      focus={[{ from: 58, id: "copy" }]}
      pointer={{
        path: [
          { frame: 0, to: { x: 1320, y: 820 } },
          { frame: 60, to: { x: 1320, y: 820 } },
          { frame: 88, to: "copy" },
        ],
        clicks: [92],
      }}
    >
      {({ hovered, pressed }) => (
        <div className="flex justify-center pt-40">
          <section data-focus="ui" className="w-[560px] rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
            <header className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-zinc-900">{team}</h2>
                <p className="mt-0.5 text-sm text-zinc-500">3 members</p>
              </div>
              <Reveal at={30} axis="x">
                <button
                  data-focus="copy"
                  className={`ml-4 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-zinc-200 ${
                    pressed("copy") ? "bg-zinc-100" : hovered("copy") ? "bg-zinc-50" : "bg-white"
                  } text-zinc-800`}
                >
                  <Swap
                    at={94}
                    before={<span className="inline-flex items-center gap-2"><LinkIcon />Copy invite link</span>}
                    after={<span className="inline-flex items-center gap-2 text-emerald-700"><CheckIcon />Copied</span>}
                  />
                </button>
              </Reveal>
            </header>
            <ul className="mt-5 divide-y divide-zinc-100">
              {people.map(([initials, name, role]) => (
                <li key={name} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">{initials}</span>
                    <span className="text-sm font-medium text-zinc-800">{name}</span>
                  </div>
                  <span className="text-sm text-zinc-500">{role}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Stage>
  );
}
