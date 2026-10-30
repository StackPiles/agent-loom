# Third-party notices

Agent Loom's original application code is licensed under the repository's [MIT license](LICENSE). Its dependencies remain subject to their own licenses. Installing or redistributing Loom does not replace those licenses with the Loom license.

The following direct runtime inventory was checked against the installed packages for the initial lockfile on **2026-10-30**. The lockfile is the authoritative version record. Dependency updates should review these notices. Transitive packages and their original license/notice files are retained in `node_modules`; the supplied Docker build preserves those files when copying production dependencies. This table is not an exhaustive software bill of materials.

## Direct runtime dependencies

| Package                           | Installed version | License                             | Upstream                                                     |
| --------------------------------- | ----------------- | ----------------------------------- | ------------------------------------------------------------ |
| `@earendil-works/pi-ai`           | 1.4.0             | MIT                                 | [Pi](https://github.com/earendil-works/pi)                   |
| `@earendil-works/pi-coding-agent` | 1.4.0             | MIT                                 | [Pi](https://github.com/earendil-works/pi)                   |
| `@sinclair/typebox`               | 0.34.52           | MIT                                 | [TypeBox](https://github.com/sinclairzx81/sinclair-typebox)  |
| `@fastify/static`                 | 10.1.8            | MIT                                 | [Fastify static](https://github.com/fastify/fastify-static)  |
| `fastify`                         | 5.12.7            | MIT                                 | [Fastify](https://github.com/fastify/fastify)                |
| `imapflow`                        | 1.7.8             | MIT                                 | [ImapFlow](https://github.com/postalsys/imapflow)            |
| `lucide-react`                    | 0.468.0           | ISC; inherited Feather portions MIT | [Lucide](https://github.com/lucide-icons/lucide)             |
| `motion`                          | 12.43.0           | MIT                                 | [Motion](https://github.com/motiondivision/motion)           |
| `react`                           | 19.3.1            | MIT                                 | [React](https://github.com/react/react)                      |
| `react-dom`                       | 19.3.1            | MIT                                 | [React](https://github.com/react/react)                      |
| `react-markdown`                  | 10.1.0            | MIT                                 | [React Markdown](https://github.com/remarkjs/react-markdown) |
| `remark-gfm`                      | 4.0.1             | MIT                                 | [remark-gfm](https://github.com/remarkjs/remark-gfm)         |
| `zod`                             | 4.6.7             | MIT                                 | [Zod](https://github.com/colinhacks/zod)                     |

The transitive `@earendil-works/pi-agent-core` package belongs to the same Pi repository and is also MIT licensed. Pi's upstream license is reproduced below because the coding-agent npm package does not include a top-level license file in the inspected distribution.

## MIT notices

The following copyright notices accompany the standard MIT permission text below:

- **Pi:** Copyright (c) 2025 Mario Zechner.
- **TypeBox:** Copyright (c) 2017-2026 Haydn Paterson.
- **@fastify/static:** Copyright (c) 2017-present The Fastify team. Team members: <https://github.com/fastify/fastify#team>.
- **Fastify:** Copyright (c) 2016-present The Fastify team <https://github.com/fastify/fastify#team>.
- **Motion:** Copyright (c) 2024 [Motion](https://motion.dev) B.V.
- **React and React DOM:** Copyright (c) Meta Platforms, Inc. and affiliates.
- **React Markdown:** Copyright (c) Espen Hovlandsdal.
- **remark-gfm:** Copyright (c) Titus Wormer <tituswormer@gmail.com>.
- **Zod:** Copyright (c) 2025 Colin McDonnell.

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ImapFlow

The following reproduces the license text distributed in the inspected ImapFlow package:

```text
Copyright (c) 2020-2024 Postal Systems OÜ

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Lucide

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Development tooling

TypeScript is distributed under Apache-2.0. Vite, its React plugin, tsx, Prettier, and the listed DefinitelyTyped type packages are distributed under MIT licenses. Their original notices are included with the installed packages. Build tooling is not copied as a production dependency by the supplied Docker build.

## Research references and brands

The design research references **Hermes Agent** (Nous Research), **OpenCode**, and **DeepSeek Harness** (DeepSeek). Their source repositories published MIT licenses when reviewed. They are design references; Loom does not bundle their runtimes, copy their source into its own implementation, or claim their plugin compatibility. See [docs/RESEARCH.md](docs/RESEARCH.md) for source links and design decisions.

Names and trademarks belong to their respective owners. No upstream logo or brand asset is included as Loom's own identity. Model weights, hosted API services, search providers, and mail accounts are supplied separately by the operator and have their own terms.
