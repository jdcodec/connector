import chalk from "chalk";

/**
 * Onboarding display helpers — colour palette + reusable strings.
 *
 * Output goes to stdout (`console.log`) so the onboarding subcommands
 * print to the user's terminal. The MCP stdio proxy path keeps stdout
 * reserved for protocol traffic and uses stderr for logs; the
 * onboarding subcommands run as one-shot interactive flows that exit
 * before the proxy ever starts, so there is no protocol conflict.
 */

export const palette = {
  info: chalk.cyan,
  warning: chalk.yellow,
  danger: chalk.bold.red,
  success: chalk.green,
  successBold: chalk.bold.green,
  bold: chalk.bold,
  dim: chalk.dim,
  white: chalk.white,
  cyanUnderline: chalk.cyan.underline,
};

/**
 * Canonical docs root, referenced by `--help`, `doctor`, and any
 * other surface that needs to point a customer at jdcodec.com/docs.
 * Kept here (not in `./index.ts`) so leaf modules like `doctor.ts`
 * can import it without forming a circular dependency through the
 * onboarding dispatcher.
 */
export const DOCS_URL = "https://jdcodec.com/docs";

export const LOGO_ASCII = `       _
      / \\
     //\\ \\
    //  \\ \\
         \\ \\
  // \\\\   \\ \\
 //  //    \\ \\
 =============
 JD CODEC   ==
 @ 2026`;

/**
 * Consent text shown before browser-based OAuth captures the user's
 * email. Copy is canonical and should match the same wording shown on
 * the web waitlist form and recorded server-side at completion time.
 */
export const CONSENT_TEXT =
  "By continuing, you agree to receive JD Codec waitlist and early-access " +
  "emails. Unsubscribe anytime via the link in any email.";

/** Default I/O surface — overridable for tests. */
export interface DisplayIO {
  print: (line: string) => void;
}

export const defaultDisplay: DisplayIO = {
  print: (line: string) => {
    process.stdout.write(line + "\n");
  },
};

export function printLogo(io: DisplayIO = defaultDisplay): void {
  io.print(palette.info(LOGO_ASCII));
}
