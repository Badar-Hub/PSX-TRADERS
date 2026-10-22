import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AuthScreen } from '@/components/AuthScreen';
import { Banner, Button } from '@/components/ui';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { countdown } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';

const CODE_LENGTH = 6;
/** The API's own resend cooldown, so the button can show it rather than
 * letting the user press into a 429. */
const RESEND_COOLDOWN_SECONDS = 60;

export default function Verify(): React.ReactNode {
  const { account, codeExpiresAt, verify, resend, signOut } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<TextInput>(null);

  const email = account?.email ?? '';

  /*
   * The countdown.
   *
   * A ten-minute life is only a real constraint if the user can see it running
   * out — otherwise a code that died while they went to find their phone just
   * looks like the app rejecting the right number. The clock ticks once a
   * second and the expiry comes from the server's own timestamp, so the app
   * and the API agree on when it dies.
   */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const remaining = useMemo(() => {
    if (codeExpiresAt === null) return null;
    const expiry = Date.parse(codeExpiresAt);
    if (Number.isNaN(expiry)) return null;
    return expiry - now;
  }, [codeExpiresAt, now]);

  const expired = remaining !== null && remaining <= 0;

  const submit = async (value: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await verify({ email, code: value });
      // The gate moves on to the awaiting-approval screen.
    } catch (caught) {
      setCode('');
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'Could not check that code');
      }
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const onChange = (text: string): void => {
    const digits = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    // Submitting on the sixth digit saves a tap, and the code is either right
    // or it is not — there is nothing to review before sending it.
    if (digits.length === CODE_LENGTH && !busy) void submit(digits);
  };

  const requestNew = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await resend(email);
      setCode('');
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice(`A new code is on its way to ${email}. It lasts 10 minutes.`);
      input.current?.focus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send a new code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen
      title="Check your email"
      subtitle={`We sent a ${CODE_LENGTH}-digit code to ${email}. Codes are valid for 10 minutes.`}
    >
      {error !== null ? (
        <View style={styles.banner}>
          <Banner kind="error">{error}</Banner>
        </View>
      ) : null}
      {notice !== null ? (
        <View style={styles.banner}>
          <Banner kind="info">{notice}</Banner>
        </View>
      ) : null}
      {expired ? (
        <View style={styles.banner}>
          <Banner kind="warn">That code has expired. Send yourself a new one.</Banner>
        </View>
      ) : null}

      <Pressable onPress={() => input.current?.focus()} style={styles.boxes}>
        {Array.from({ length: CODE_LENGTH }, (_, index) => {
          const digit = code[index];
          return (
            <View
              key={index}
              style={[
                styles.box,
                index === code.length ? styles.boxActive : null,
                digit !== undefined ? styles.boxFilled : null,
              ]}
            >
              <Text style={styles.boxText}>{digit ?? ''}</Text>
            </View>
          );
        })}
      </Pressable>

      {/* One hidden input behind six boxes. Six separate inputs look the same
          but fight the keyboard, the autofill suggestion and every paste of
          "123 456" out of the email. */}
      <TextInput
        ref={input}
        value={code}
        onChangeText={onChange}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        autoFocus
        maxLength={CODE_LENGTH}
        editable={!busy}
        style={styles.hidden}
        accessibilityLabel={`${CODE_LENGTH}-digit verification code`}
      />

      {remaining !== null && !expired ? (
        <Text style={styles.timer}>Expires in {countdown(remaining)}</Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          onPress={() => void requestNew()}
          variant="ghost"
          busy={busy && code === ''}
          disabled={cooldown > 0}
        >
          {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
        </Button>
        <Button onPress={() => void signOut()} variant="ghost">
          Use a different account
        </Button>
      </View>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  banner: { marginBottom: space.lg },
  boxes: { flexDirection: 'row', gap: space.sm, justifyContent: 'center' },
  box: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    borderWidth: 1,
    height: 58,
    justifyContent: 'center',
    width: 46,
  },
  boxActive: { borderColor: colors.accent },
  boxFilled: { borderColor: colors.borderStrong, backgroundColor: colors.surfaceRaised },
  boxText: { color: colors.text, fontSize: 24, fontWeight: '600' },
  // Zero-opacity rather than unrendered: the input has to exist and be
  // focusable for the keyboard and the SMS/mail autofill to work at all.
  hidden: { height: 1, opacity: 0, position: 'absolute', width: 1 },
  timer: { color: colors.textMuted, fontSize: 13, marginTop: space.lg, textAlign: 'center' },
  actions: { gap: space.sm, marginTop: space.xl },
});
