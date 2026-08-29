ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS bookings_party_size_check;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_party_size_check
    CHECK (party_size BETWEEN 1 AND 30);
