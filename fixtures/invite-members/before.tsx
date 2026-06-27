// components/MembersCard.tsx  (BEFORE)
const members = [
  { initials: "MC", name: "Maya Chen", email: "maya@acme.com", role: "Admin" },
  { initials: "TP", name: "Theo Park", email: "theo@acme.com", role: "Member" },
  { initials: "IR", name: "Inès Roux", email: "ines@acme.com", role: "Member" },
];

export function MembersCard() {
  return (
    <div className="rounded-2xl bg-[#16161F] shadow-2xl ring-1 ring-white/5 w-[840px]">
      <div className="px-10 h-[110px] flex items-center justify-between border-b border-white/10">
        <div className="flex flex-col">
          <h2 className="text-[#F5F5F7] text-2xl font-bold">Members</h2>
          <p className="text-[#8A8A9A] text-sm font-medium">3 people in Acme</p>
        </div>
      </div>

      <div className="px-10 divide-y divide-white/10">
        {members.map((m) => (
          <div key={m.email} className="h-[96px] flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-[#3A3A44] flex items-center justify-center text-white text-sm font-bold">
                {m.initials}
              </div>
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-lg font-semibold">{m.name}</span>
                <span className="text-[#8A8A9A] text-sm font-medium">{m.email}</span>
              </div>
            </div>
            <span className="text-[#8A8A9A] text-sm font-medium">{m.role}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
