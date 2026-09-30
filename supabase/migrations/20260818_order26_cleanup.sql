-- ============================================================
-- Friends of 323
-- Order #26 cleanup
--
-- RECOMMENDED: use SECTION A to void/cancel the order.
-- Do NOT run both Section A and Section B.
-- ============================================================


-- ============================================================
-- SECTION A -- RECOMMENDED
-- Mark internal Order #26 as voided/cancelled and retain audit history.
-- ============================================================

begin;

do $$
declare
    v_order_id uuid;
    v_status public.order_record_status;
begin
    select id, record_status
      into v_order_id, v_status
    from public.orders
    where order_number = 26;

    if v_order_id is null then
        raise exception 'Order #26 was not found.';
    end if;

    if v_status = 'voided' then
        raise exception 'Order #26 is already voided.';
    end if;

    -- Protect against cancelling an order already included on a PO.
    if exists (
        select 1
        from public.purchase_order_allocations poa
        join public.order_items oi
          on oi.id = poa.order_item_id
        where oi.order_id = v_order_id
    ) then
        raise exception
            'Order #26 has purchase-order allocations and must be removed from/cancelled on the purchase order first.';
    end if;
end $$;

update public.orders
set
    record_status = 'voided',
    void_reason = 'Test/import order cancelled',
    voided_by = auth.uid(),
    voided_at = now(),
    updated_by = auth.uid()
where order_number = 26;

commit;


-- Verify:
select
    order_number,
    store_order_number,
    ecwid_order_number,
    order_source,
    record_status,
    void_reason,
    voided_at
from public.orders
where order_number = 26;


/*
-- ============================================================
-- SECTION B -- OPTIONAL HARD DELETE
--
-- ONLY use this instead of Section A if you truly want the
-- record physically removed. Leave customers/scouts/products intact.
-- Do not run if Section A was already run unless you intentionally
-- want to delete the voided record afterward.
-- ============================================================

begin;

do $$
declare
    v_order_id uuid;
begin
    select id
      into v_order_id
    from public.orders
    where order_number = 26;

    if v_order_id is null then
        raise exception 'Order #26 was not found.';
    end if;

    if exists (
        select 1
        from public.purchase_order_allocations poa
        join public.order_items oi
          on oi.id = poa.order_item_id
        where oi.order_id = v_order_id
    ) then
        raise exception
            'Order #26 has purchase-order allocations and will not be deleted.';
    end if;
end $$;

delete from public.order_items
where order_id = (
    select id
    from public.orders
    where order_number = 26
);

delete from public.orders
where order_number = 26;

commit;

-- Verify: should return no rows.
select *
from public.orders
where order_number = 26;
*/
