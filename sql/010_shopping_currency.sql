-- Apply after 009_shopping.sql. Existing items adopt their household currency.
BEGIN;

ALTER TABLE housemate.shopping_items ADD COLUMN currency text;
UPDATE housemate.shopping_items si SET currency = h.default_currency
  FROM housemate.households h WHERE h.id = si.household_id;
ALTER TABLE housemate.shopping_items ALTER COLUMN currency SET NOT NULL;
ALTER TABLE housemate.shopping_items
  ADD CONSTRAINT shopping_items_currency_check CHECK (currency IN ('USD', 'THB'));

-- A saved shopping price has monetary meaning, so it locks household currency.
UPDATE housemate.households h SET currency_locked_at = COALESCE(currency_locked_at, now())
  WHERE EXISTS (
    SELECT 1 FROM housemate.shopping_items si WHERE si.household_id = h.id
      AND (si.estimated_price_minor IS NOT NULL OR si.purchased_price_minor IS NOT NULL)
  );

COMMIT;
