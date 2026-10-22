import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '@/lib/session';
import { PortfolioProvider } from '@/lib/portfolio';
import { colors } from '@/lib/theme';
import { Loading } from '@/components/ui';

/**
 * The gate.
 *
 * One rule, in one place: the account's `next` decides which group of screens
 * the user is in. A member who has not entered their code cannot reach the
 * portfolio tabs, and a fully approved member cannot get stuck on the verify
 * screen. Doing this here rather than per screen means there is no screen that
 * forgot to check.
 *
 * This is convenience and clarity, not security. The real gate is the API,
 * which re-reads the account's status on every request; the worst a bypass of
 * this redirect achieves is an empty screen.
 */
function Gate(): React.ReactNode {
  const { loading, account, next } = useSession();
  const segments = useSegments();
  const router = useRouter();

  const group = segments[0];

  useEffect(() => {
    if (loading) return;

    const inAuth = group === '(auth)';
    // The signal, trade, stop and admin screens sit outside the tab group so
    // they can be pushed over it; they still belong to the signed-in half.
    const inApp =
      group === '(app)' ||
      group === 'signal' ||
      group === 'trade' ||
      group === 'stop' ||
      group === 'admin';

    if (account === null) {
      if (!inAuth) router.replace('/(auth)/sign-in');
      return;
    }

    switch (next) {
      case 'VERIFY_EMAIL':
        router.replace('/(auth)/verify');
        return;
      case 'AWAITING_APPROVAL':
        router.replace('/(auth)/pending');
        return;
      case 'BLOCKED':
        router.replace('/(auth)/blocked');
        return;
      case 'READY':
        if (!inApp) router.replace('/(app)/positions');
        return;
      default:
        return;
    }
  }, [loading, account, next, group, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <Loading what="Checking your session" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontSize: 16 },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
      <Stack.Screen name="signal/[symbol]" options={{ title: 'Prediction' }} />
      <Stack.Screen name="trade/new" options={{ presentation: 'modal', title: 'Record a trade' }} />
      <Stack.Screen name="stop/new" options={{ presentation: 'modal', title: 'Watch a symbol' }} />
      <Stack.Screen name="admin/users" options={{ title: 'Approval queue' }} />
    </Stack>
  );
}

export default function RootLayout(): React.ReactNode {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <PortfolioProvider>
          <StatusBar style="light" />
          <Gate />
        </PortfolioProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
