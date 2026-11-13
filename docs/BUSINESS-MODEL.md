# Business model

**Hearthbrew Coffee Gear** is a fictional direct-to-consumer seller of home coffee equipment. All data is synthetic.

| SKU | Price | Unit cost | Opening stock | Expected leads/day |
|---|---:|---:|---:|---:|
| Gooseneck kettle | $64 | $26 | 34 | 4 |
| Ceramic dripper | $32 | $9 | 50 | 6 |
| Burr grinder | $149 | $62 | 24 | 3 |
| Filter papers ×200 | $12 | $3 | 160 | 8 |

- **Customers.** There are 40 synthetic customers: 30 retail customers (`R-xx`) and 10 cafés (`C-xx`). Cafés buy in larger quantities and sometimes ask for discounts. Each customer has a patience value, in business hours. A customer whose unshipped order is past its *current* promise is **at risk**. A customer whose order passes promise + patience gives up, asks to cancel, and is **lost**. Re-promising early, before the customer has been waiting, moves the current promise. That is why re-promising waiting customers early protects them. The KPI `Orders re-promised` counts orders that received a new date; it does not claim each notice came before the old date passed.
- **Suppliers.** *Northgate* is the primary supplier: unit cost as listed, 3-day lead time, prepaid. *Swiftline* is a pre-vetted backup: +35% cost, 1-day lead time, prepaid.
- **Operating costs.** Shipping is $6 per parcel. Staff cost $350 per business day. Advertising is $80 a day when Sales requests it and Finance pays it.
- **Capacity.** The packing bench handles 4 parcels per business hour, and the carrier takes 8 business hours to deliver.
- **Opening position.** $14,000 cash plus opening inventory at cost, both against Opening Equity.
- **Cash cycle.** Customers pay at order. The money is held as a deposit, a liability, until the order ships, and only then becomes revenue. Purchases are prepaid into Supplier Advances and become inventory on receipt.

## The numbers on screen
| KPI | Definition | Source |
|---|---|---|
| Bookings | Value of orders placed | `orders` |
| Recognised revenue | Credit balance of Revenue (gross: refunds and credits are not deducted) | journal, posted only by `PostShipment` |
| Net revenue | Recognised revenue minus the Refunds & Credits balance | journal |
| Cash | Debit balance of Cash | journal |
| Net income | Revenue − refunds − COGS − shipping − ads − staff | journal |
| Backlog | Paid orders not yet shipped | `orders` |
| Late vs first promise | Orders shipped, or still open, after the first promise made to the customer | `orders.original_promise` |
| Customers lost | Customers whose status became `churned` | `customers` |

Every KPI tile opens the rows it is computed from.
