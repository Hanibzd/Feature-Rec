"use client";

import { useState } from "react";

export function SettingsCard() {
  const [dark, setDark] = useState(true);

  return (
    <div className="rounded-2xl bg-[#16161F] shadow-2xl ring-1 ring-white/5 w-[800px]">
      <div className="px-10 h-[100px] flex flex-col justify-center">
        <h2 className="text-[#F5F5F7] text-2xl font-bold">Settings</h2>
        <p className="text-[#8A8A9A] text-sm font-medium">Manage your workspace preferences</p>
      </div>

      <div className="px-10 divide-y divide-white/10">
        <div className="h-[92px] flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[#F5F5F7] text-xl font-semibold">Account</span>
            <span className="text-[#8A8A9A] text-sm font-medium">team@acme.com</span>
          </div>
          <span className="text-[#C7C7D2] text-sm font-medium">Manage</span>
        </div>

        <div className="h-[92px] flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[#F5F5F7] text-xl font-semibold">Notifications</span>
            <span className="text-[#8A8A9A] text-sm font-medium">Email me about releases</span>
          </div>
          <span className="text-[#6C5CE7] text-sm font-semibold">On</span>
        </div>

        {/* Appearance row — dark mode toggle */}
        <div className="h-[92px] flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-[#F5F5F7] text-xl font-semibold">Appearance</span>
            <span className="text-[#8A8A9A] text-sm font-medium">Use dark theme across the app</span>
          </div>
          <button
            onClick={() => setDark((d) => !d)}
            aria-pressed={dark}
            className="relative w-[64px] h-[34px] rounded-full p-1 transition-colors"
            style={{ background: dark ? "#6C5CE7" : "#3A3A44" }}
          >
            <span
              className="block w-[26px] h-[26px] rounded-full bg-white shadow transition-transform"
              style={{ transform: dark ? "translateX(30px)" : "translateX(0px)" }}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
