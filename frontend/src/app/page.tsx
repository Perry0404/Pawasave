'use client';

import { StoreProvider, useStore } from '@/lib/store';
import AuthScreen from '@/components/auth-screen';
import AppShell from '@/components/app-shell';

function AppGate() {
  const { state } = useStore();
  if (!state.user) return <AuthScreen />;
  return <AppShell />;
}

export default function Home() {
  return (
    <StoreProvider>
      <AppGate />
    </StoreProvider>
  );
}
