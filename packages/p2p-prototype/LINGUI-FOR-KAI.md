# Lingui strings for Kai

`P2PConnectError` (`src/connect-error.ts`) carries fixed Vietnamese text in `userMessage` and the matching English in `userMessageEn`, chosen by `code`. `p2pConnectMessage(code)` returns both. When the product wires them in, add these two messages to the catalogs; the prototype does not touch any `.po` file.

| `code` | When | Shown message |
|---|---|---|
| `timeout` | The data channel was not open in time. | not reached |
| `no_candidate_pair` | The connection closed before it opened, or ICE failed and one side had no candidates, so no pair could be checked. | not reached |
| `ice_failed` | ICE failed although both sides had candidates. | network blocking |

The code is for logs, not for the person; show the message for any `P2PConnectError`.

## Not reached (`timeout`, `no_candidate_pair`)

| | Text |
|---|---|
| English `msgid` | `Could not connect to your computer. Check that it is turned on, or try another network (4G or home wifi).` |
| Vietnamese `msgstr` | `Không kết nối được tới máy của bạn. Kiểm tra máy đang bật, hoặc thử mạng khác (4G hoặc wifi nhà).` |

New message.

## Network blocking (`ice_failed`)

| | Text |
|---|---|
| English `msgid` | `Your network is blocking direct connections, try another network (4G or home wifi).` |
| Vietnamese `msgstr` | `Mạng của bạn đang chặn kết nối trực tiếp, hãy thử mạng khác (4G hoặc wifi nhà).` |

Unchanged text. It used to be shown for every code; it now appears only for `ice_failed`.
