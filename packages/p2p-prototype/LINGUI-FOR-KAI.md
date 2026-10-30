# Lingui strings for Kai

`P2PConnectError.userMessage` (`src/connect-error.ts`) is a fixed Vietnamese string in the prototype. When the product wires it in, add this message to the catalogs; the prototype does not touch any `.po` file.

| | Text |
|---|---|
| English `msgid` | `Couldn't connect to your machine. This network may be blocking UDP, try another network.` |
| Vietnamese `msgstr` | `Không kết nối được tới máy của bạn. Mạng này có thể đang chặn UDP, hãy thử mạng khác.` |

Show it for any `P2PConnectError` (`code` is `ice_failed`, `no_candidate_pair` or `timeout`); the code is for logs, not for the person.
