# Third-party notices

DSH-Remote is an independent companion project for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is not an official DeepSeek mobile application. DeepSeek names and whale branding are used for identification; the project's MIT license does not grant trademark rights.

Browser assets under `src/remote/ui/vendor/` retain their upstream notices:

| Component | Distribution license | Included notice |
| --- | --- | --- |
| Marked | MIT | `src/remote/ui/vendor/marked/LICENSE` |
| KaTeX and its bundled fonts | MIT | `src/remote/ui/vendor/katex/LICENSE` |
| DOMPurify | Apache-2.0 distribution option | `src/remote/ui/vendor/dompurify/LICENSE` |

Node dependencies are installed through `package-lock.json`; their licenses remain in their npm distributions. Android SDK/JDK, FRP executables and DeepSeek Harness are external prerequisites and are not bundled into this source repository. The top-level MIT license applies to this project's original code, subject to these upstream notices.
