import AdminView from '@/components/admin-view'
import Logo from '@/components/logo'

export const metadata = {
  title: 'PawaSave Admin',
  robots: 'noindex, nofollow',
}

export default function AdminPage() {
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="bg-slate-900 px-5 pt-4 pb-3 flex items-center gap-2.5 sticky top-0 z-50">
        <Logo size={32} />
        <div>
          <p className="text-white text-sm font-bold tracking-tight">PawaSave</p>
          <p className="text-slate-500 text-[11px]">Admin Panel</p>
        </div>
      </header>
      <main className="max-w-2xl mx-auto pb-10">
        <AdminView />
      </main>
    </div>
  )
}
