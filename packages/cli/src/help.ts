/** Plain help text. It says what each command does with values, and the limits nobody should have to discover. */
export const VERSION = "0.1.0";

export const HELP = `mosshatch ${VERSION}: your Nest secrets on the command line.

Usage:
  mosshatch login                              Sign in. You approve this computer with your passkey on mosshatch.com.
  mosshatch logout [--local-only]              Revoke this computer's sign-in and forget it here.
  mosshatch whoami                             Show what this sign-in can do.
  mosshatch run <domain> [--env dev] -- <command> [args...]
                                               Run a command with the secrets in its environment. Nothing is written to disk.
  mosshatch pull <domain> [--env dev] (--out <file> | --stdout) [--format dotenv|shell]
                                               Write the secrets to a new file (mode 0600) or, only when you ask, to the terminal.
  mosshatch push <domain> [--env dev] [<file> | -]
                                               Store every NAME=value in a dotenv file (or standard input) as a secret.
  mosshatch help                               Show this text.

Environments are dev (the default), preview and prod. A sign-in covers dev and preview; prod works only for domains you
named when you approved it.

What to know:
  - Prefer "run". Values then reach your program without passing through a file, a terminal or an agent's output.
  - "pull" needs --out or --stdout and does nothing without one. --out never overwrites a file, never follows a symlink
    and refuses paths inside a .git directory. --stdout prints values: use it only when you mean to.
  - Values are never printed unless you ask with --stdout. When the output of "run" is not a terminal, values that
    appear in it are masked; masking is best effort (encoded, split or transformed values get through).
  - Environment variables can be read by other programs running as the same user, and by root.
  - Names that change how programs start (PATH, LD_PRELOAD, NODE_OPTIONS, the rest of the list the API serves) are
    refused. The list cannot cover every variable every program reads.
  - Never put a token on the command line. For scripts, set MOSSHATCH_TOKEN in the environment instead of signing in.
  - Your sign-in is kept in a file only you can read. The system keychain is used instead only when the optional
    @napi-rs/keyring module is installed beside mosshatch and a keychain answers; login says which one it used.

Exit codes: 0 done, 1 failed, 2 usage, 3 refused a reserved name, 4 not signed in, 75 the vault is unavailable (try
again later), 77 this sign-in does not allow that. "run" returns the command's own exit code.
`;
