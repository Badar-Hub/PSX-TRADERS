import { View } from 'react-native';
import { colors } from '@/lib/theme';
import { Loading } from '@/components/ui';

/**
 * The landing route, which nobody stays on.
 *
 * The gate in `_layout.tsx` sends the user to the auth group or the tabs as
 * soon as the account is known. This exists so there is something to render
 * during that one frame, rather than a blank white flash on a dark app.
 */
export default function Index(): React.ReactNode {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
      <Loading />
    </View>
  );
}
