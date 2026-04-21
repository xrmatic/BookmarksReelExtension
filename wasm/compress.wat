;; Bookmarks Reel - WASM Image Compression Pre-processor
;; Quantizes pixel colour channels to reduce unique values and improve JPEG compression.
;; Memory layout: raw RGBA pixel bytes written at offset 0 by the caller.

(module
  (memory (export "memory") 256)   ;; 256 pages = 16 MB shared memory

  ;; applyCompressionFilter(ptr: i32, len: i32)
  ;; Rounds each R/G/B channel to the nearest multiple of `step` (32 by default),
  ;; leaving the alpha channel (every 4th byte) untouched.
  (func (export "applyCompressionFilter")
    (param $ptr i32) (param $len i32)
    (local $i   i32)
    (local $val i32)
    (local $mod i32)
    (local $rounded i32)
    (local.set $i (i32.const 0))

    (block $break
      (loop $loop
        ;; Exit when i >= len
        (br_if $break (i32.ge_u (local.get $i) (local.get $len)))

        ;; Only process R, G, B – skip every 4th byte (alpha)
        (local.set $mod (i32.rem_u (local.get $i) (i32.const 4)))
        (if (i32.ne (local.get $mod) (i32.const 3))
          (then
            (local.set $val
              (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))

            ;; Round to nearest multiple of 32  →  8 discrete levels per channel
            (local.set $rounded
              (i32.shl
                (i32.div_u
                  (i32.add (local.get $val) (i32.const 16))
                  (i32.const 32))
                (i32.const 5)))

            ;; Clamp to 255
            (if (i32.gt_u (local.get $rounded) (i32.const 255))
              (then (local.set $rounded (i32.const 255))))

            (i32.store8
              (i32.add (local.get $ptr) (local.get $i))
              (local.get $rounded))
          )
        )

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )

  ;; getMemorySize() -> i32  (returns number of available bytes)
  (func (export "getMemorySize") (result i32)
    (i32.shl (memory.size) (i32.const 16))
  )
)
