import { Banner, Box, Button, Spinner } from "@stripe/ui-extension-sdk/ui";
import type { Strings } from "./i18n";

export const Loading = ({ t }: { t: Strings }) => (
  <Box css={{ stack: "y", alignX: "center", paddingY: "xlarge", gap: "small" }}>
    <Spinner />
    <Box css={{ font: "caption", color: "secondary" }}>{t.loading}</Box>
  </Box>
);

export const MissingKey = ({ t }: { t: Strings }) => (
  <Banner type="caution" title={t.notConfiguredTitle} description={t.notConfiguredBody} />
);

export const ErrorState = ({ t, message, onRetry }: { t: Strings; message: string; onRetry: () => void }) => (
  <Banner type="critical" title={t.errorTitle} description={message} actions={<Button onPress={onRetry}>{t.retry}</Button>} />
);
