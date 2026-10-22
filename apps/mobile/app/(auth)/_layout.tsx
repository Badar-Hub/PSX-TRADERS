import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export default function AuthLayout(): React.ReactNode {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        // No swipe-back between the onboarding steps. Which step the user is on
        // is a fact about their account, not a place in a navigation history,
        // and a gesture that appears to undo it would be a lie.
        gestureEnabled: false,
        animation: 'fade',
      }}
    />
  );
}
