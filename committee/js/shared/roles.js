export const ROLE_LABELS={coffee_bean:"Coffee Bean",barista:"Barista",committee_member:"Cupper",treasurer:"Bean Counter"};
export const ROLE_LEVEL={committee_member:1,barista:2,coffee_bean:3};
export function hasMinimumRole(current,required){return (ROLE_LEVEL[current]||0)>=(ROLE_LEVEL[required]||99)}
