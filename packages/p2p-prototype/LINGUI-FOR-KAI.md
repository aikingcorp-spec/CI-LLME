# Lingui strings for Kai

`P2PConnectError.userMessage` (`src/connect-error.ts`) is a fixed Vietnamese string in the prototype. When the product wires it in, add this message to the catalogs; the prototype does not touch any `.po` file.

| | Text |
|---|---|
| English `msgid` | `Your network is blocking direct connections, try another network (4G or home wifi).` |
| Vietnamese `msgstr` | `Mạng của bạn đang chặn kết nối trực tiếp, hãy thử mạng khác (4G hoặc wifi nhà).` |

Show it for any `P2PConnectError` (`code` is `ice_failed`, `no_candidate_pair` or `timeout`); the code is for logs, not for the person.
