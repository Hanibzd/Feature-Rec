import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 bg-[#08080C]">
      <h1 className="text-[#F5F5F7] text-4xl font-bold">Acme</h1>
      <Link className="text-[#6C5CE7] text-lg font-semibold underline" href="/settings">
        Go to Settings →
      </Link>
    </main>
  );
}
