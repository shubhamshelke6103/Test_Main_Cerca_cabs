const deleteButton = document.getElementById("delete-button");
const modal = document.getElementById("confirmModal");

const cancelDelete = document.getElementById("cancelDelete");
const confirmDelete = document.getElementById("confirmDelete");

const message = document.getElementById("delete-message");

deleteButton.addEventListener("click", () => {

    const identifier = document
        .getElementById("identifier")
        .value
        .trim();

    if(identifier===""){
        alert("Please enter your Email or Mobile Number.");
        return;
    }

    modal.style.display="flex";
});

cancelDelete.onclick=()=>{

    modal.style.display="none";
}

confirmDelete.onclick=async()=>{

    modal.style.display="none";

    const identifier=document
        .getElementById("identifier")
        .value
        .trim();

    try{

        const res=await fetch("/request/delete-account",{

            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({
                identifier
            })

        });

        const data=await res.json();

        if(data.success){

            message.style.color="green";

            message.innerHTML=data.message;

        }else{

            message.style.color="red";

            message.innerHTML=data.message;

        }

    }catch(err){

        message.style.color="red";

        message.innerHTML="Something went wrong.";

    }

}