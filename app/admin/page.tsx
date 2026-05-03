import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default function AdminHome() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Admin</h1>
      <ul className="list-disc pl-6 text-gray-700">
        <li><Link href="/admin/users" className="text-blue-600 hover:underline">Users & redemption</Link></li>
        <li><Link href="/admin/items" className="text-blue-600 hover:underline">Items catalog</Link></li>
      </ul>
    </div>
  );
}
