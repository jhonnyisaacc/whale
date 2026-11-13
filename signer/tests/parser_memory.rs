use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Largest;

static LARGEST: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Largest {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LARGEST.fetch_max(layout.size(), Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Largest = Largest;

fn largest_allocation_while_parsing(message: &[u8]) -> usize {
    LARGEST.store(0, Ordering::SeqCst);
    assert!(whale_signer::solana::parse(message).is_err());
    LARGEST.load(Ordering::SeqCst)
}

#[test]
fn a_short_message_claiming_huge_counts_reserves_no_large_buffer() {
    let huge = [0xff, 0xff, 0x7f];
    let keys = [&[1, 0, 0][..], &huge].concat();
    let instructions = [&[1, 0, 0, 0][..], &[0; 32], &huge].concat();
    let accounts = [&[1, 0, 0, 0][..], &[0; 32], &[1, 0], &huge].concat();
    for (name, message) in [
        ("keys", keys),
        ("instructions", instructions),
        ("accounts", accounts),
    ] {
        let largest = largest_allocation_while_parsing(&message);
        assert!(
            largest < 4096,
            "a {}-byte message with a huge {name} count reserved {largest} bytes",
            message.len()
        );
    }
}
