-- Review fix (C-66): a take-down holds the domain's card until support reinstates it. Before this, the owner could publish
-- the same name again at once with a new step-up, undoing a notice, an authority request or a registrar-directed hold.
-- 'reinstated' marks a take-down that support lifted (counter-notice or put-back); the card stays unpublished and the owner
-- may publish again. The publish gate looks for a 'taken_down' row on the same domain.
alter table cards drop constraint cards_takedown_state_check;
alter table cards add constraint cards_takedown_state_check check (takedown_state in ('none','taken_down','reinstated'));
create index cards_takedown_hold on cards (domain_id) where takedown_state = 'taken_down';
