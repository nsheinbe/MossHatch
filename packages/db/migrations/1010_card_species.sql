-- Species by name (core deriveCreatureSpec): a card's family is any species id and its rarity is one of four tiers, set by how rare
-- the name reads. Only widens the two checks from 1000_cards.sql; existing rows stay valid.

alter table cards drop constraint if exists cards_family_check;
alter table cards add constraint cards_family_check
  check (family in ('fox','hare','beetle','hedgehog','owl','koi','moth','salamander','spiritfox'));
alter table cards drop constraint if exists cards_rarity_check;
alter table cards add constraint cards_rarity_check
  check (rarity in ('common','uncommon','rare','legendary'));
