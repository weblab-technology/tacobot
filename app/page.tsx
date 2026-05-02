import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold">🌮 Tacobot</h1>
      <p className="mt-4 text-gray-600">
        Internal recognition program. Give tacos in Slack, redeem them via HR.
      </p>
      <div className="mt-8 flex gap-4">
        <Link href="/shop" className="rounded bg-amber-500 px-4 py-2 text-white hover:bg-amber-600">
          Shop
        </Link>
      </div>
    </main>
  );
}
