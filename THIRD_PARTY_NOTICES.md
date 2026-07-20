# Third-Party Notices

This project includes code derived from third-party open source software. The original license text for each is reproduced below, as required by its terms.

## fontello/svgpath

`packages/core/src/geometry/bbox.ts` ports the arc-to-cubic-bezier conversion (`getArcCenter`, `approximateUnitArc`, `arcToCubicCurves`) from [fontello/svgpath](https://github.com/fontello/svgpath)'s `lib/a2c.js`, translated from its original `snake_case` to this project's `camelCase` convention, with no other functional changes to that algorithm.

```
(The MIT License)

Copyright (C) 2013-2015 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
