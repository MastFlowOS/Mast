# `queues/` — Queue Manager (Milestone 4.1)

Source: Engine BluePrint, Phase 1.4 ("Queue System, Concurrency &
Recovery") and Phase 1.5 ("V2 Folder Structure").

## Naming decision (supersedes the old `queue/` placeholder)

The Phase 1.5 target layout names this package `queue/`. The
Milestone 1 placeholder that used to live at this path (see git
history / the old `queue/README.md`) deliberately shipped with **no**
`__init__.py`, precisely so it could not be imported, and explicitly
deferred the real naming decision to "Phase 4 (Queue Framework), when
this package's first real code is written and the tradeoffs can be
weighed against actual usage."

That milestone is this one. Before writing any code, the tradeoff was
verified empirically rather than assumed:

```pycon
>>> import sys; sys.path.insert(0, ".")   # project root, as service.py/main.py do
>>> import queue
<module 'queue' from '/usr/lib/python3.12/queue.py'>
>>> from queue import queue_manager
ImportError: cannot import name 'queue_manager' from 'queue'
```

Even **without** an `__init__.py`, a bare `queue/` directory only ever
becomes an implicit PEP 420 "namespace package". Python's import
resolution always prefers a real module — the standard library's own
`queue.py` — over a namespace package, no matter where each is found
on `sys.path`. Concretely: this project inserts its own root directory
at the front of `sys.path` (running `python service.py` / `python
main.py` directly, per the old README), so `queue/` is found first —
but because it has no `__init__.py`, Python doesn't stop there; it
keeps scanning the rest of `sys.path`, finds the standard library's
real `queue.py`, and uses *that* as `queue`. The result: files placed
at `queue/queue_manager.py` would exist on disk but could **never**
actually be imported as `queue.queue_manager` — not a risk of shadowing
the standard library, but the reverse: this project's own code would be
the one silently shadowed and permanently unreachable.

**Decision (confirmed by the person driving this milestone):** rename
the package to **`queues/`** (this directory). Nothing else about the
Phase 1.5 target layout changes — file names, responsibilities, and
the rest of the V2 folder structure are unaffected; only the top-level
package name differs from the blueprint's literal `queue/` spelling,
for the reason above. `queues/` does not collide with anything in the
standard library, so it takes a normal `__init__.py`-free (for now) or
`__init__.py`-bearing package with no special-casing required.

## What's implemented (Milestone 4.1)

- `queue_definition.py` — `QueueDefinition`: immutable queue
  configuration (queue_id, queue_name, stage, retry_policy,
  priority_policy).
- `queue_record.py` — `QueueRecord`: mutable runtime counters
  (pending/processing/completed/failed) for one queue.
- `queue_item.py` — `QueueItem`: immutable unit of work
  (queue_item_id, pipeline_id, stage, payload, created_at,
  retry_count).
- `queue.py` — `Queue`: owns one `QueueDefinition`, one `QueueRecord`,
  and FIFO storage of `QueueItem`s. `enqueue()` / `dequeue()` /
  `peek()` / `size()` / `is_empty()`. Strict FIFO — no priorities, no
  reservations, no retries, no delayed jobs, no expiration, no
  dead-letter queue.
- `queue_manager.py` — `QueueManager`: owns a collection of `Queue`s,
  one per `QueueDefinition`. `create_queue()` / `delete_queue()` /
  `get_queue()` / `list_queues()`. Delegates every FIFO operation to
  the correct `Queue`; never touches a `QueueItem` directly.

`QueueManager` and `Queue` know nothing about Workers, `WorkerPool`,
`WorkerGroup`, `WorkerHandle`, `WorkerAllocator`, Providers, or
Sessions — no file in this package imports anything from `workers/`.
See the module docstrings in `queue_manager.py` and `queue.py` for why
that separation is load-bearing, not incidental (Phase 1.4 "Core
Philosophy": "Queues own work. Workers consume work. Workers never own
work.").

## Future responsibility

Per the blueprint's Phase 1.5 target layout (adjusted for the
`queues/` naming decision above), this package will eventually also
hold:

- `queues/reservation.py` — reservation + ACK semantics (Phase 1.4
  "Reservation Model").
- `queues/heartbeat.py` — worker heartbeat tracking / reservation
  expiry.
- `queues/retry.py` (`retry_policy.py` per Phase 1.5) — bounded
  retries and dead-lettering, reading `QueueDefinition.retry_policy`.

These will back `engine.interfaces.QueueInterface` and connect to the
richer, reservation-aware `QueueItem` contract already defined in
`engine/contracts.py` (see `queue_item.py`'s module docstring for how
this milestone's smaller `QueueItem` relates to that one — the two are
not yet reconciled, on purpose).
