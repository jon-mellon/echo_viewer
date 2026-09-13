# Layout compatibility oracle

`legacy_dag_layout.mjs` freezes the layout implementation immediately before the
2026-09-09 extraction into `static/dag_layout.mjs`. Its wrapper supplies the
previous global inputs explicitly so tests can compare positions, estimated
node boxes, display parameters, dimensions and signatures without a browser.
Do not change this oracle to make a changed layout pass. Intentional heuristic
changes require reviewing and updating the parity expectations separately.

The synthetic cases in `dag_layout.test.mjs` cover all three layout modes,
empty and single-node graphs, the automatic organic-layout threshold, larger
graphs, and reversed/bidirectional links and cycles. Exact parity establishes
preservation of existing behavior; it does not establish that the heuristic
always eliminates overlaps or produces an optimal layout.

`computeDagLayout` reads only its supplied groups, links, centroids, anchor IDs,
mode, dimensions and view signature. It mutates only locally allocated buffers.
The browser adapter supplies the diagnostic view signature to retain the
existing viewport-refit policy; the signature does not affect geometry.
Returned boxes use the same label-size estimates as collision resolution and
are passed directly to routing. They are not measurements of rendered DOM nodes.
